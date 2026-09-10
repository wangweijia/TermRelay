import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'events' })
export class SessionEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'session_id', type: 'varchar', length: 128 })
  sessionId!: string;

  @Column({ type: 'bigint', unsigned: true })
  seq!: string;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true })
  expiresAt!: Date | null;
}
