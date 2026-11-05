import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ControllerCredential, ControllerPairing, ControllerPairingStatus } from './controller-auth.service';

@Entity('controller_pairings')
@Index(['status', 'createdAt'])
export class ControllerPairingEntity implements ControllerPairing {
  @PrimaryColumn({ type: 'char', length: 36 }) id!: string;
  @Column({ name: 'installation_id', type: 'varchar', length: 128 }) installationId!: string;
  @Column({ name: 'device_name', type: 'varchar', length: 128 }) deviceName!: string;
  @Column({ name: 'app_version', type: 'varchar', length: 64 }) appVersion!: string;
  @Column({ name: 'device_code_hash', type: 'char', length: 64 }) deviceCodeHash!: string;
  @Column({ type: 'varchar', length: 16 }) status!: ControllerPairingStatus;
  @Column({ name: 'device_ids', type: 'json' }) deviceIds!: string[];
  @Column({ name: 'approved_by', type: 'varchar', length: 320, nullable: true }) approvedBy!: string | null;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt!: Date;
}

@Entity('controller_credentials')
export class ControllerCredentialEntity implements ControllerCredential {
  @PrimaryColumn({ type: 'char', length: 36 }) id!: string;
  @Column({ name: 'installation_id', type: 'varchar', length: 128 }) installationId!: string;
  @Column({ name: 'device_name', type: 'varchar', length: 128 }) deviceName!: string;
  @Column({ name: 'secret_hash', type: 'char', length: 64 }) secretHash!: string;
  @Column({ name: 'device_ids', type: 'json' }) deviceIds!: string[];
  @Column({ name: 'approved_by', type: 'varchar', length: 320 }) approvedBy!: string;
  @Column({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt!: Date;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true }) expiresAt!: null;
  @Column({ name: 'last_used_at', type: 'datetime', precision: 3, nullable: true }) lastUsedAt!: Date | null;
  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true }) revokedAt!: Date | null;
}