import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan } from 'typeorm';
import { ControllerCredentialEntity, ControllerPairingEntity } from './controller-auth.entity';
import { controllerDigestEqual, type ControllerAuthStore, type ControllerCredential, type ControllerExchange, type ControllerPairing } from './controller-auth.service';

@Injectable()
export class ControllerAuthRepository implements ControllerAuthStore {
  constructor(@Optional() @InjectDataSource() private readonly dataSource?: DataSource) {}

  hasPairing(id: string) { return this.database().getRepository(ControllerPairingEntity).existsBy({ id }); }

  async create(record: ControllerPairing) {
    const repository = this.database().getRepository(ControllerPairingEntity);
    if (await repository.countBy({ installationId: record.installationId, status: 'pending', expiresAt: MoreThan(record.createdAt) }) >= 3) {
      throw new ConflictException('Too many pending requests for this installation.');
    }
    await repository.insert(record);
  }

  pending(now: Date) {
    return this.database().getRepository(ControllerPairingEntity).find({
      where: { status: 'pending', expiresAt: MoreThan(now) }, order: { createdAt: 'DESC' }, take: 100,
    });
  }

  decide(id: string, decision: 'approved' | 'denied', approvedBy: string, deviceIds: string[], now: Date) {
    return this.database().transaction(async manager => {
      const repository = manager.getRepository(ControllerPairingEntity);
      const record = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!record || record.status !== 'pending' || record.expiresAt <= now) return false;
      Object.assign(record, { status: decision, approvedBy, deviceIds });
      await repository.save(record);
      return true;
    });
  }

  exchange(id: string, hash: string, credential: ControllerCredential, cancel: boolean, now: Date): Promise<ControllerExchange> {
    return this.database().transaction(async manager => {
      const repository = manager.getRepository(ControllerPairingEntity);
      const record = await repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!record || !controllerDigestEqual(record.deviceCodeHash, hash)) return { status: 'invalid_request' };
      if (record.status === 'consumed') return { status: 'invalid_request' };
      if (record.expiresAt <= now) return { status: 'expired_token' };
      if (record.status === 'denied' || record.status === 'cancelled') return { status: 'access_denied' };
      if (cancel) {
        record.status = 'cancelled';
        await repository.save(record);
        return { status: 'cancelled' };
      }
      if (record.status === 'pending') return { status: 'authorization_pending' };
      Object.assign(credential, {
        installationId: record.installationId, deviceName: record.deviceName,
        deviceIds: record.deviceIds, approvedBy: record.approvedBy,
      });
      await manager.getRepository(ControllerCredentialEntity).insert({ ...credential, expiresAt: null });
      record.status = 'consumed';
      await repository.save(record);
      return { status: 'issued', record: credential };
    });
  }

  async findCredential(id: string) {
    return (await this.database().getRepository(ControllerCredentialEntity).findOneBy({ id })) ?? undefined;
  }
  listCredentials() { return this.database().getRepository(ControllerCredentialEntity).find({ order: { createdAt: 'DESC' }, take: 500 }); }
  async touch(id: string, now: Date) { await this.database().getRepository(ControllerCredentialEntity).update({ id }, { lastUsedAt: now }); }
  async revoke(id: string, now: Date) {
    const result = await this.database().getRepository(ControllerCredentialEntity).update({ id }, { revokedAt: now });
    return result.affected === 1;
  }
  private database() {
    if (!this.dataSource) throw new Error('Controller authentication requires the database.');
    return this.dataSource;
  }
}