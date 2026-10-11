import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('ai_project_keys')
export class AIProjectKeyEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 }) id!: string;
  @Column({ name: 'project_id', type: 'varchar', length: 64 }) projectId!: string;
  @Column({ name: 'key_hash', type: 'varchar', length: 64, unique: true }) keyHash!: string;
  @Column({ type: 'json' }) grants!: { deviceIds: string[]; profiles: string[]; capacity: number };
  @Column({ type: 'boolean', default: false }) revoked!: boolean;
}

@Entity('ai_resources')
export class AIResourceEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ name: 'idempotency_scope', type: 'varchar', length: 200, unique: true }) idempotencyScope!: string;
  @Column({ type: 'json' }) data!: AIResource;
}

export interface AIResource {
  id: string;
  kind: 'job' | 'conversation' | 'turn';
  projectId: string;
  deviceId: string;
  sessionId: string;
  profile: string;
  profileVersion: number;
  provider: 'codex' | 'dsh';
  displayName: string;
  model?: string;
  effort?: string;
  fingerprint: string;
  status: 'starting' | 'ready' | 'closed' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  activeTurnId: string | null;
  waitingFor: 'approval' | 'input' | null;
  cancelRequested: boolean;
  result: unknown;
  rawText?: string;
  input?: import('@termrelay/contracts').AiInput;
  output?: import('@termrelay/contracts').AiOutput;
  schemaHash?: string;
  contextId?: string;
  error: { code: string; message: string; executionOutcome: 'unknown' | 'confirmed' | 'not_started' } | null;
  actualModel: string | null;
  actualEffort: string | null;
  usage: null;
  createdAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  cancelDeadlineAt?: string;
}
