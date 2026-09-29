import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type ShortcutRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

@Entity({ name: 'shortcut_runs' })
export class ShortcutRunEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'shortcut_id', type: 'char', length: 36 })
  shortcutId!: string;

  @Column({ name: 'device_id', type: 'varchar', length: 128 })
  deviceId!: string;

  @Column({ type: 'enum', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
  status!: ShortcutRunStatus;

  @Column({ name: 'exit_code', type: 'int', nullable: true })
  exitCode!: number | null;

  @Column({ type: 'mediumtext' })
  output!: string;

  @Column({ name: 'active_shortcut_id', type: 'char', length: 36, nullable: true })
  activeShortcutId!: string | null;

  @Column({ name: 'cancel_requested', type: 'boolean', default: false })
  cancelRequested!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)', onUpdate: 'CURRENT_TIMESTAMP(3)' })
  updatedAt!: Date;
}
