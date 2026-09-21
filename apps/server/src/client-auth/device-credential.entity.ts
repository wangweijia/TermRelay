import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'device_credentials' })
export class DeviceCredentialEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ name: 'secret_hash', type: 'char', length: 64 })
  secretHash!: string;

  @Column({ name: 'approved_by', type: 'varchar', length: 320 })
  approvedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'datetime', precision: 3, nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt!: Date | null;
}