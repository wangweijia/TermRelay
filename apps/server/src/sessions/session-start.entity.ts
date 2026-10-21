import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { SessionStartPayload } from '@termrelay/contracts';

export type SessionStartStatus = 'pending' | 'accepted' | 'completed' | 'failed' | 'unknown';

@Entity({ name: 'session_starts' })
export class SessionStartEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ type: 'json' })
  request!: SessionStartPayload;

  @Column({ type: 'enum', enum: ['pending', 'accepted', 'completed', 'failed', 'unknown'] })
  status!: SessionStartStatus;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  message!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)', onUpdate: 'CURRENT_TIMESTAMP(3)' })
  updatedAt!: Date;
}
