import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  type ClientAuthStore,
  type ClientPairingRecord,
  type DeviceCredentialRecord,
} from './client-auth.service';
import { ClientPairingEntity } from './client-pairing.entity';
import { DeviceCredentialEntity } from './device-credential.entity';

@Injectable()
export class ClientAuthRepository implements ClientAuthStore {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  async createPairing(record: ClientPairingRecord): Promise<void> {
    await this.database().getRepository(ClientPairingEntity).insert(record);
  }

  async findPairing(
    userCodeHash: string,
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    const pairings = this.database().getRepository(ClientPairingEntity);
    const pairing = await pairings.findOneBy({ userCodeHash });
    if (!pairing) return undefined;
    if (pairing.status === 'pending' && pairing.expiresAt <= now) {
      pairing.status = 'expired';
      await pairings.save(pairing);
    }
    return pairing;
  }

  approvePairing(
    userCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    return this.decidePairing(userCodeHash, approvedBy, 'approved', now);
  }

  denyPairing(
    userCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    return this.decidePairing(userCodeHash, approvedBy, 'denied', now);
  }

  exchangePairing(
    pairingId: string,
    deviceCodeHash: string,
    credential: DeviceCredentialRecord,
    now: Date,
  ): Promise<'issued' | 'pending' | 'denied' | 'expired' | 'consumed' | 'invalid'> {
    return this.database().transaction(async (manager) => {
      const pairings = manager.getRepository(ClientPairingEntity);
      const pairing = await pairings.findOne({
        where: { id: pairingId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!pairing || pairing.deviceCodeHash !== deviceCodeHash) return 'invalid';
      if (pairing.expiresAt <= now) {
        pairing.status = 'expired';
        await pairings.save(pairing);
        return 'expired';
      }
      if (pairing.status !== 'approved') return pairing.status;

      credential.deviceId = pairing.deviceId;
      credential.approvedBy = pairing.approvedBy!;
      await manager.getRepository(DeviceCredentialEntity).insert(credential);
      pairing.status = 'consumed';
      pairing.consumedAt = now;
      await pairings.save(pairing);
      return 'issued';
    });
  }

  async findCredential(id: string): Promise<DeviceCredentialRecord | undefined> {
    return (await this.database().getRepository(DeviceCredentialEntity).findOneBy({ id }))
      ?? undefined;
  }

  listCredentials(): Promise<DeviceCredentialRecord[]> {
    return this.database().getRepository(DeviceCredentialEntity).find({
      order: { createdAt: 'DESC' },
    });
  }

  async touchCredential(id: string, now: Date): Promise<void> {
    await this.database().getRepository(DeviceCredentialEntity).update(
      { id },
      { lastUsedAt: now },
    );
  }

  revokeCredential(id: string, now: Date): Promise<DeviceCredentialRecord | undefined> {
    return this.database().transaction(async (manager) => {
      const credentials = manager.getRepository(DeviceCredentialEntity);
      const credential = await credentials.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!credential) return undefined;
      credential.revokedAt ??= now;
      return credentials.save(credential);
    });
  }

  private decidePairing(
    userCodeHash: string,
    approvedBy: string,
    status: 'approved' | 'denied',
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    return this.database().transaction(async (manager) => {
      const pairings = manager.getRepository(ClientPairingEntity);
      const pairing = await pairings.findOne({
        where: { userCodeHash },
        lock: { mode: 'pessimistic_write' },
      });
      if (!pairing || pairing.status !== 'pending') return undefined;
      if (pairing.expiresAt <= now) {
        pairing.status = 'expired';
        await pairings.save(pairing);
        return undefined;
      }
      pairing.status = status;
      pairing.approvedBy = approvedBy;
      if (status === 'approved') pairing.approvedAt = now;
      return pairings.save(pairing);
    });
  }

  private database(): DataSource {
    if (!this.dataSource) throw new Error('Client authentication requires the database.');
    return this.dataSource;
  }
}