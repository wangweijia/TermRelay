import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import { SessionEventEntity } from './session-event.entity';
import { SessionEntity } from './session.entity';
import { SessionRepository } from './session.repository';

test('disconnect permanently removes only unused ACP sessions for that device', async () => {
  const store = new MemorySessions([
    session('empty-acp', 'acp'),
    session('used-acp', 'acp', { hasUserMessage: true }),
    session('pty', 'pty'),
    session('already-finished', 'acp', { status: 'finished' }),
    session('other-device', 'acp', { deviceId: 'device-b' }),
  ]);

  await store.repository.finishActiveForDevice('device-a');

  assert.deepEqual(store.sessionIDs(), ['other-device', 'pty', 'used-acp']);
  assert.deepEqual(store.purgedIDs.sort(), ['already-finished', 'empty-acp']);
  assert.equal(store.rows.get('used-acp')?.status, 'finished');
  assert.equal(store.rows.get('pty')?.status, 'finished');
  assert.equal(store.rows.get('other-device')?.status, 'running');
  assert.deepEqual(store.deletedChildren.sort(), [
    'commands:already-finished', 'approvals:already-finished', 'events:already-finished',
    'commands:empty-acp', 'approvals:empty-acp', 'events:empty-acp',
  ].sort());
});

test('startup removes previously disconnected unused ACP sessions, not failed or used sessions', async () => {
  const store = new MemorySessions([
    session('old-empty', 'acp', { status: 'finished' }),
    session('new-empty', 'acp'),
    session('used', 'acp', { status: 'finished', hasUserMessage: true }),
    session('failed', 'acp', { status: 'failed' }),
    session('pty', 'pty', { status: 'finished' }),
  ]);

  await store.repository.finishAllActive();

  assert.deepEqual(store.sessionIDs(), ['failed', 'pty', 'used']);
  assert.deepEqual(store.purgedIDs.sort(), ['new-empty', 'old-empty']);
});

test('a persisted user message protects its ACP session even after event history expires', async () => {
  const store = new MemorySessions([session('used', 'acp'), session('empty', 'acp')]);
  const result = await store.repository.appendToolEvent('device-a', 'used', 1, {
    kind: 'user.message',
    occurredAt: new Date().toISOString(),
    correlation: {},
    data: { messageId: 'one', text: 'hello' },
  });

  assert.equal(result.status, 'accepted');
  assert.equal(store.rows.get('used')?.hasUserMessage, true);
  store.events.length = 0;
  const finished = await store.repository.finishById('used');
  assert.equal(typeof finished === 'object' ? finished.status : undefined, 'finished');
  assert.equal(await store.repository.finishById('empty'), 'purged');
  assert.deepEqual(store.sessionIDs(), ['used']);
});

test('a routed Web message protects the session before the Mac event arrives', async () => {
  const store = new MemorySessions([
    session('web-message', 'acp'),
    session('ended', 'acp', { status: 'finished' }),
  ]);

  assert.equal(await store.repository.markUserMessageIntent('device-a', 'web-message'), true);
  assert.equal(await store.repository.markUserMessageIntent('device-b', 'web-message'), false);
  assert.equal(await store.repository.markUserMessageIntent('device-a', 'ended'), false);
  await store.repository.finishActiveForDevice('device-a');

  assert.deepEqual(store.sessionIDs(), ['web-message']);
  assert.equal(store.rows.get('web-message')?.hasUserMessage, true);
});

test('provider-only ACP events do not count as user messages', async () => {
  const store = new MemorySessions([session('no-user', 'acp')]);
  const result = await store.repository.appendToolEvent('device-a', 'no-user', 1, {
    kind: 'warning',
    occurredAt: new Date().toISOString(),
    correlation: {},
    data: { code: 'provider_started', message: 'ready' },
  });
  assert.equal(result.status, 'accepted');
  assert.equal(store.rows.get('no-user')?.stateVersion, '1');
  assert.equal(await store.repository.finishById('no-user'), 'purged');
  assert.deepEqual(store.sessionIDs(), []);
});

test('history index filters device, deletion, mode, and tool before paging', async () => {
    const store = new MemorySessions([
      session('old', 'acp', { toolKey: 'copilot', updatedAt: new Date(1_000) }),
      session('new', 'acp', { toolKey: 'copilot', updatedAt: new Date(2_000) }),
      session('newer-tie', 'acp', { toolKey: 'copilot', updatedAt: new Date(2_000) }),
      session('deleted', 'acp', { toolKey: 'copilot', deletedAt: new Date(3_000) }),
      session('other-device', 'acp', { deviceId: 'device-b', toolKey: 'copilot' }),
      session('other-tool', 'acp', { toolKey: 'codex' }),
      session('pty', 'pty', { toolKey: 'copilot' }),
    ]);
    assert.deepEqual(
      (await store.repository.listCopilotHistoryForDevice('device-a', undefined, 1)).map((row) => row.id),
      ['newer-tie'],
    );
    assert.deepEqual(
      (await store.repository.listCopilotHistoryForDevice(
        'device-a', { updatedAt: new Date(2_000), id: 'newer-tie' }, 1,
      )).map((row) => row.id),
      ['new'],
    );
    assert.deepEqual(
      (await store.repository.listCopilotHistoryForDevice(
        'device-a', { updatedAt: new Date(2_000), id: 'new' }, 1,
      )).map((row) => row.id),
      ['old'],
    );
});

test('PTY output retains its 24-hour TTL while ACP events default to 30 days and allow an override', async () => {
  const previousTerminalTtl = process.env.TERMINAL_EVENT_TTL_HOURS;
  const previousAcpTtl = process.env.ACP_EVENT_TTL_HOURS;
  try {
    process.env.TERMINAL_EVENT_TTL_HOURS = '24';
    delete process.env.ACP_EVENT_TTL_HOURS;
    const defaults = new MemorySessions([
      session('pty', 'pty'),
      session('acp', 'acp'),
    ]);
    const start = Date.now();
    await defaults.repository.appendTerminalOutput('device-a', 'pty', 1, {
      encoding: 'base64', data: 'dGVzdA==',
    });
    await defaults.repository.appendToolEvent('device-a', 'acp', 1, {
      kind: 'warning', occurredAt: new Date().toISOString(),
      correlation: {}, data: { code: 'ready', message: 'ready' },
    });
    const end = Date.now();
    for (const [id, hours] of [['pty', 24], ['acp', 30 * 24]] as const) {
      const expiry = defaults.events.find((event) => event.sessionId === id)?.expiresAt.getTime();
      assert.ok(expiry !== undefined && expiry >= start + hours * 3_600_000);
      assert.ok(expiry <= end + hours * 3_600_000);
    }

    process.env.ACP_EVENT_TTL_HOURS = '48';
    const configured = new MemorySessions([session('configured', 'acp')]);
    const configuredStart = Date.now();
    await configured.repository.appendToolEvent('device-a', 'configured', 1, {
      kind: 'warning', occurredAt: new Date().toISOString(),
      correlation: {}, data: { code: 'ready', message: 'ready' },
    });
    const configuredEnd = Date.now();
    const expiry = configured.events[0]?.expiresAt.getTime();
    assert.ok(expiry !== undefined && expiry >= configuredStart + 48 * 3_600_000);
    assert.ok(expiry <= configuredEnd + 48 * 3_600_000);
  } finally {
    if (previousTerminalTtl === undefined) delete process.env.TERMINAL_EVENT_TTL_HOURS;
    else process.env.TERMINAL_EVENT_TTL_HOURS = previousTerminalTtl;
    if (previousAcpTtl === undefined) delete process.env.ACP_EVENT_TTL_HOURS;
    else process.env.ACP_EVENT_TTL_HOURS = previousAcpTtl;
  }
});

function session(
  id: string,
  runtimeMode: 'acp' | 'pty',
  overrides: Partial<SessionEntity> = {},
): SessionEntity {
  return Object.assign(new SessionEntity(), {
    id,
    deviceId: 'device-a',
    workspaceId: 'workspace-a',
    toolKey: 'codex',
    displayName: null,
    runtimeMode,
    status: 'running',
    stateVersion: '0',
    autoApproveEnabled: false,
    hasUserMessage: false,
    startedAt: new Date(1_000),
    finishedAt: null,
    deletedAt: null,
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
    ...overrides,
  });
}

class MemorySessions {
  readonly rows: Map<string, SessionEntity>;
  readonly events: Array<{ sessionId: string; seq: string; type: string; expiresAt: Date }> = [];
  readonly purgedIDs: string[] = [];
  readonly deletedChildren: string[] = [];
  readonly repository: SessionRepository;

  constructor(sessions: SessionEntity[]) {
    this.rows = new Map(sessions.map((item) => [item.id, item]));
    const sessionsRepo = {
      createQueryBuilder: () => new MemoryQuery(this.rows),
      update: async (criteria: { id: string }, values: Partial<SessionEntity>) => {
        const row = this.rows.get(criteria.id);
        if (row) Object.assign(row, values);
      },
      delete: async (criteria: { id: string }) => {
        this.purgedIDs.push(criteria.id);
        this.rows.delete(criteria.id);
      },
      findOneBy: async (criteria: { id: string }) => this.rows.get(criteria.id) ?? null,
    };
    const eventsRepo = {
      findOneBy: async () => null,
      insert: async (event: { sessionId: string; seq: string; type: string; expiresAt: Date }) => {
        this.events.push(event);
      },
    };
    const manager = {
      getRepository: (entity: unknown) => entity === SessionEntity ? sessionsRepo : eventsRepo,
      createQueryBuilder: () => ({
        delete: () => ({
          from: (table: string) => ({
            where: (_clause: string, params: { id: string }) => ({
              execute: async () => {
                this.deletedChildren.push(`${table}:${params.id}`);
              },
            }),
          }),
        }),
      }),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: async <T>(work: (entityManager: EntityManager) => Promise<T>): Promise<T> => work(manager),
      getRepository: (entity: unknown) => entity === SessionEntity ? sessionsRepo : eventsRepo,
    } as unknown as DataSource;
    this.repository = new SessionRepository(dataSource);
  }

  sessionIDs(): string[] {
    return [...this.rows.keys()].sort();
  }
}

class MemoryQuery {
  private clauses: Array<{ sql: string; params: Record<string, unknown> }> = [];
  private values: Partial<SessionEntity> = {};
  private limitValue?: number;

  constructor(private readonly rows: Map<string, SessionEntity>) {}

  update(): this { return this; }
  set(values: Partial<SessionEntity>): this { this.values = values; return this; }
  setLock(): this { return this; }
  orderBy(): this { return this; }
  addOrderBy(): this { return this; }
  limit(value: number): this { this.limitValue = value; return this; }
  where(sql: string, params: Record<string, unknown> = {}): this {
    this.clauses = [{ sql, params }];
    return this;
  }
  andWhere(sql: string, params: Record<string, unknown> = {}): this {
    this.clauses.push({ sql, params });
    return this;
  }
  async execute(): Promise<void> {
    for (const row of await this.getMany()) Object.assign(row, this.values);
  }
  async getOne(): Promise<SessionEntity | null> {
    return (await this.getMany())[0] ?? null;
  }
  async getMany(): Promise<SessionEntity[]> {
    const filtered = [...this.rows.values()].filter((row) => this.clauses.every(({ sql, params }) => {
      if (sql.includes('status IN')) return (params.statuses as string[]).includes(row.status);
      if (sql.includes('device_id =')) return row.deviceId === params.deviceId;
      if (sql.includes('session_id =') || sql.includes('session.id =') || sql.includes('id =')) {
        return row.id === (params.sessionId ?? params.id);
      }
      if (sql.includes('session.runtimeMode')) return row.runtimeMode === (params.mode ?? params.runtimeMode);
      if (sql.includes('session.status')) return row.status === params.status;
      if (sql.includes('session.hasUserMessage')) return row.hasUserMessage === params.hasUserMessage;
      if (sql.includes('session.deletedAt')) return row.deletedAt === null;
      if (sql.includes('session.deviceId')) return row.deviceId === params.deviceId;
      if (sql.includes('session.updatedAt <')) {
        const updatedAt = params.updatedAt as Date;
        return row.updatedAt < updatedAt || (row.updatedAt.getTime() === updatedAt.getTime()
          && row.id < params.cursorId!);
      }
      if (sql.includes('session.toolKey')) return row.toolKey === params.toolKey;
      throw new Error(`Unhandled test query: ${sql}`);
    }));
    if (this.limitValue === undefined) return filtered;
    return filtered
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, this.limitValue);
  }
}
