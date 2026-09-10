import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';

export type DeviceDatabaseStatus =
  | 'connected'
  | 'connecting'
  | 'offline'
  | 'degraded';

export interface DeviceCapabilities {
  platform: 'macOS';
  tools: string[];
  activeSessionCount: number;
  registeredAt: string;
  disconnectedAt?: string;
}

@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({
    type: 'enum',
    enum: ['connected', 'connecting', 'offline', 'degraded'],
    default: 'offline',
  })
  status!: DeviceDatabaseStatus;

  @Column({ type: 'json' })
  capabilities!: DeviceCapabilities;

  @Column({ name: 'app_version', type: 'varchar', length: 64, nullable: true })
  appVersion!: string | null;

  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3, nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
