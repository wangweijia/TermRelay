import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ClientPairingStatus } from './client-auth.service';

@Entity({ name: 'client_pairings' })
export class ClientPairingEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ name: 'device_name', type: 'varchar', length: 128 })
  deviceName!: string;

  @Column({ name: 'app_version', type: 'varchar', length: 64 })
  appVersion!: string;

  @Column({ name: 'device_code_hash', type: 'char', length: 64 })
  deviceCodeHash!: string;

  @Column({ name: 'user_code_hash', type: 'char', length: 64, unique: true })
  userCodeHash!: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'approved', 'denied', 'consumed', 'expired'],
    default: 'pending',
  })
  status!: ClientPairingStatus;

  @Column({ name: 'approved_by', type: 'varchar', length: 320, nullable: true })
  approvedBy!: string | null;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt!: Date;

  @Column({ name: 'approved_at', type: 'datetime', precision: 3, nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'consumed_at', type: 'datetime', precision: 3, nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}