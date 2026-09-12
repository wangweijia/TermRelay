import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { SessionRuntimeMode } from '@termrelay/contracts';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'finished'
  | 'failed';

@Entity({ name: 'sessions' })
export class SessionEntity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  id!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ name: 'workspace_id', type: 'varchar', length: 128 })
  workspaceId!: string;

  @Column({ name: 'tool_key', type: 'varchar', length: 64 })
  toolKey!: string;

  @Column({
    name: 'runtime_mode',
    type: 'enum',
    enum: ['terminal', 'structured'],
    default: 'terminal',
  })
  runtimeMode!: SessionRuntimeMode;

  @Column({
    type: 'enum',
    enum: ['starting', 'running', 'stopping', 'finished', 'failed'],
  })
  status!: SessionStatus;

  @Column({ name: 'state_version', type: 'bigint', unsigned: true, default: 0 })
  stateVersion!: string;

  @Column({ name: 'started_at', type: 'datetime', precision: 3, nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'datetime', precision: 3, nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'deleted_at', type: 'datetime', precision: 3, nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
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
