import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  SessionStartedPayload,
  TerminalOutputPayload,
  ToolEventPayload,
} from '@termrelay/contracts';
import { DataSource, type EntityManager, IsNull, Repository } from 'typeorm';
import { SessionEventEntity } from './session-event.entity';
import { SessionEntity, type SessionStatus } from './session.entity';

export interface SessionRecord {
  id: string;
  deviceId: string;
  workspaceId: string;
  toolKey: string;
  displayName: string | null;
  runtimeMode: SessionEntity['runtimeMode'];
  webDisplayMode?: SessionEntity['webDisplayMode'];
  status: SessionStatus;
  stateVersion: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type SessionWriteResult =
  | { status: 'accepted'; event: SessionEventRecord }
  | { status: 'duplicate' }
  | { status: 'conflict'; detail: string }
  | { status: 'unknown_session' };

export type SessionDeleteResult = 'deleted' | 'not_found' | 'not_finished';

@Injectable()
export class SessionRepository {
  private readonly terminalEventTtlMs =
    readPositiveInteger('TERMINAL_EVENT_TTL_HOURS', 24) * 60 * 60 * 1_000;

  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  get enabled(): boolean {
    return this.dataSource !== undefined;
  }

  async registerStarted(
    deviceId: string,
    sessionId: string,
    payload: SessionStartedPayload,
  ): Promise<SessionWriteResult> {
    if (!this.dataSource) {
      return { status: 'conflict', detail: 'Database is disabled.' };
    }

    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(SessionEntity);
      const existing = await sessions.findOneBy({ id: sessionId });
      if (existing) {
        const startEvent = await manager
          .getRepository(SessionEventEntity)
          .findOneBy({ sessionId, seq: '0' });
        const sameIdentity =
          existing.deviceId === deviceId &&
          existing.workspaceId === payload.workspaceId &&
          existing.toolKey === payload.toolKey &&
          existing.runtimeMode === payload.runtimeMode &&
          existing.webDisplayMode === (payload.webDisplayMode ?? 'full') &&
          startEvent !== null &&
          sameEvent(startEvent, 'session.started', payload);
        if (sameIdentity) {
          await sessions.update(
            { id: sessionId },
            { status: 'running', finishedAt: null, deletedAt: null },
          );
          return { status: 'duplicate' };
        }
        return {
          status: 'conflict',
          detail: 'Session ID or sequence 0 contains different metadata.',
        };
      }

      const createdAt = new Date();
      await sessions.insert({
        id: sessionId,
        deviceId,
        workspaceId: payload.workspaceId,
        toolKey: payload.toolKey,
        displayName: payload.displayName ?? null,
        runtimeMode: payload.runtimeMode,
        webDisplayMode: payload.webDisplayMode ?? 'full',
        status: 'running',
        stateVersion: '0',
        startedAt: new Date(payload.startedAt),
        finishedAt: null,
        deletedAt: null,
      });
      await manager.getRepository(SessionEventEntity).insert({
        sessionId,
        seq: '0',
        type: 'session.started',
        payload: { ...payload },
        createdAt,
        expiresAt: null,
      });
      return {
        status: 'accepted',
        event: {
          seq: 0,
          type: 'session.started',
          payload: { ...payload },
          createdAt: createdAt.toISOString(),
        },
      };
    });
  }

  async appendTerminalOutput(
    deviceId: string,
    sessionId: string,
    seq: number,
    payload: TerminalOutputPayload,
  ): Promise<SessionWriteResult> {
    return this.appendEvent(deviceId, sessionId, seq, 'terminal.output', payload);
  }

  async appendToolEvent(
    deviceId: string,
    sessionId: string,
    seq: number,
    payload: ToolEventPayload,
  ): Promise<SessionWriteResult> {
    return this.appendEvent(deviceId, sessionId, seq, 'tool.event', payload);
  }

  private async appendEvent(
    deviceId: string,
    sessionId: string,
    seq: number,
    type: 'terminal.output' | 'tool.event',
    payload: TerminalOutputPayload | ToolEventPayload,
  ): Promise<SessionWriteResult> {
    if (!this.dataSource) {
      return { status: 'conflict', detail: 'Database is disabled.' };
    }

    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(SessionEntity);
      const session = await sessions
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.id = :sessionId', { sessionId })
        .getOne();
      if (!session || session.deviceId !== deviceId) {
        return { status: 'unknown_session' };
      }
      if (!canAppendSessionEvent(session.runtimeMode, type)) {
        return { status: 'conflict', detail: `${type} is not valid for a ${session.runtimeMode} session.` };
      }

      const events = manager.getRepository(SessionEventEntity);
      const existing = await events.findOneBy({ sessionId, seq: String(seq) });
      if (existing) {
        return sameEvent(existing, type, payload)
          ? { status: 'duplicate' }
          : {
              status: 'conflict',
              detail: `Sequence ${seq} already contains a different event.`,
            };
      }

      const expectedSeq = Number(session.stateVersion) + 1;
      if (seq !== expectedSeq) {
        return {
          status: 'conflict',
          detail: `Expected sequence ${expectedSeq}, received ${seq}.`,
        };
      }

      const createdAt = new Date();
      await events.insert({
        sessionId,
        seq: String(seq),
        type,
        payload: { ...payload },
        createdAt,
        expiresAt: new Date(Date.now() + this.terminalEventTtlMs),
      });
      if (type === 'tool.event') {
        await persistApprovalProjection(manager, sessionId, payload as ToolEventPayload);
      }
      await sessions.update(
        { id: sessionId },
        { stateVersion: String(seq) },
      );
      return {
        status: 'accepted',
        event: {
          seq,
          type,
          payload: { ...payload },
          createdAt: createdAt.toISOString(),
        },
      };
    });
  }

  async list(): Promise<SessionRecord[]> {
    if (!this.dataSource) return [];
    const sessions = await this.repository.find({
      where: { deletedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    return sessions.map(toSessionRecord);
  }

  async findById(id: string): Promise<SessionRecord | undefined> {
    if (!this.dataSource) return undefined;
    const session = await this.repository.findOneBy({ id, deletedAt: IsNull() });
    return session ? toSessionRecord(session) : undefined;
  }

  async deleteFinished(id: string, purge: boolean): Promise<SessionDeleteResult> {
    if (!this.dataSource) return 'not_found';

    return this.dataSource.transaction(async (manager) => {
      const sessions = manager.getRepository(SessionEntity);
      const session = await sessions
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.id = :id', { id })
        .getOne();
      if (!session || (!purge && session.deletedAt !== null)) return 'not_found';
      if (session.status !== 'finished') return 'not_finished';

      if (!purge) {
        await sessions.update({ id }, { deletedAt: new Date() });
        return 'deleted';
      }

      for (const table of ['commands', 'approvals', 'events']) {
        await manager
          .createQueryBuilder()
          .delete()
          .from(table)
          .where('session_id = :id', { id })
          .execute();
      }
      await sessions.delete({ id });
      return 'deleted';
    });
  }

  async finishActiveForDevice(deviceId: string, finishedAt = new Date()): Promise<void> {
    if (!this.dataSource) return;
    await this.repository
      .createQueryBuilder()
      .update(SessionEntity)
      .set({ status: 'finished', finishedAt })
      .where('device_id = :deviceId', { deviceId })
      .andWhere('status IN (:...statuses)', {
        statuses: ['starting', 'running', 'stopping'],
      })
      .execute();
  }

  async finishAllActive(finishedAt = new Date()): Promise<void> {
    if (!this.dataSource) return;
    await this.repository
      .createQueryBuilder()
      .update(SessionEntity)
      .set({ status: 'finished', finishedAt })
      .where('status IN (:...statuses)', {
        statuses: ['starting', 'running', 'stopping'],
      })
      .execute();
  }

  async finishById(
    id: string,
    finishedAt = new Date(),
    status: Extract<SessionStatus, 'finished' | 'failed'> = 'finished',
  ): Promise<SessionRecord | undefined> {
    if (!this.dataSource) return undefined;
    await this.repository
      .createQueryBuilder()
      .update(SessionEntity)
      .set({ status, finishedAt })
      .where('id = :id', { id })
      .andWhere('status IN (:...statuses)', {
        statuses: ['starting', 'running', 'stopping'],
      })
      .execute();
    return this.findById(id);
  }

  async listEvents(
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<SessionEventRecord[]> {
    if (!this.dataSource) return [];
    const events = await this.dataSource
      .getRepository(SessionEventEntity)
      .createQueryBuilder('event')
      .where('event.sessionId = :sessionId', { sessionId })
      .andWhere('event.seq > :afterSeq', { afterSeq })
      .andWhere('(event.expiresAt IS NULL OR event.expiresAt > CURRENT_TIMESTAMP(3))')
      .orderBy('event.seq', 'ASC')
      .limit(limit)
      .getMany();
    return events.map(toEventRecord);
  }

  private get repository(): Repository<SessionEntity> {
    if (!this.dataSource) throw new Error('Database is disabled.');
    return this.dataSource.getRepository(SessionEntity);
  }
}

export function canAppendSessionEvent(
  runtimeMode: SessionEntity['runtimeMode'],
  type: 'terminal.output' | 'tool.event',
): boolean {
  return type === 'terminal.output'
    ? runtimeMode === 'terminal' || runtimeMode === 'structured'
    : runtimeMode === 'structured';
}

async function persistApprovalProjection(
  manager: EntityManager,
  sessionId: string,
  payload: ToolEventPayload,
): Promise<void> {
  const data = payload.data;
  if (payload.kind === 'approval.requested') {
    await manager.query(
      `INSERT INTO approvals
        (session_id, approval_key, turn_ref, item_ref, risk, request, decision, expires_at)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'pending', ?)
       ON DUPLICATE KEY UPDATE
        turn_ref = VALUES(turn_ref), item_ref = VALUES(item_ref), risk = VALUES(risk),
        request = VALUES(request), expires_at = VALUES(expires_at)`,
      [
        sessionId,
        data.approvalId,
        data.turnId,
        data.itemId ?? null,
        data.risk,
        JSON.stringify(data),
        new Date(String(data.expiresAt)),
      ],
    );
    return;
  }
  if (payload.kind === 'approval.resolved') {
    const decision = data.decision === 'allowOnce' ? 'approved' : 'denied';
    await manager.query(
      `UPDATE approvals SET decision = ?, decided_by = 'remote-user', decided_at = CURRENT_TIMESTAMP(3)
       WHERE session_id = ? AND approval_key = ? AND decision = 'pending'`,
      [decision, sessionId, data.approvalId],
    );
  }
}

function sameEvent(
  event: SessionEventEntity,
  type: string,
  payload: unknown,
): boolean {
  return event.type === type && canonicalJson(event.payload) === canonicalJson(payload);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function toSessionRecord(session: SessionEntity): SessionRecord {
  return {
    id: session.id,
    deviceId: session.deviceId,
    workspaceId: session.workspaceId,
    toolKey: session.toolKey,
    displayName: session.displayName,
    runtimeMode: session.runtimeMode,
    webDisplayMode: session.webDisplayMode,
    status: session.status,
    stateVersion: Number(session.stateVersion),
    startedAt: session.startedAt?.toISOString() ?? null,
    finishedAt: session.finishedAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function toEventRecord(event: SessionEventEntity): SessionEventRecord {
  return {
    seq: Number(event.seq),
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
