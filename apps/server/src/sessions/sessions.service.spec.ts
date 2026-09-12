import assert from 'node:assert/strict';
import test from 'node:test';
import type { DevicesService } from '../devices/devices.service';
import type { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { canAppendSessionEvent, type SessionRepository } from './session.repository';
import { SessionsService } from './sessions.service';
import type { WorkspaceEntity } from './workspace.entity';
import type { WorkspaceRepository } from './workspace.repository';

test('serializes workspace registration before session registration', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const service = makeService(workspaces, sessions);

  const workspaceWrite = service.registerWorkspace('device-a', {
    workspaceId: 'workspace-a',
    displayName: 'Workspace A',
    available: true,
    remoteStartAllowed: false,
  });
  const sessionWrite = service.registerSession('device-a', 'session-a', {
    workspaceId: 'workspace-a',
    toolKey: 'codex',
    runtimeMode: 'terminal',
    startedAt: new Date().toISOString(),
  });

  assert.deepEqual(await Promise.all([workspaceWrite, sessionWrite]), [
    { status: 'accepted' },
    { status: 'accepted' },
  ]);
  assert.deepEqual(sessions.registrations, ['session-a']);
});

test('rejects sessions for unavailable workspaces', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const service = makeService(workspaces, sessions);

  const result = await service.registerSession('device-a', 'session-a', {
    workspaceId: 'missing',
    toolKey: 'shell',
    runtimeMode: 'terminal',
    startedAt: new Date().toISOString(),
  });

  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.equal(result.code, 'unauthorized_workspace');
  }
});

test('maps sequence conflicts from terminal output persistence', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  sessions.outputResult = {
    status: 'conflict',
    detail: 'Expected sequence 2, received 3.',
  };
  const service = makeService(workspaces, sessions);

  const result = await service.appendTerminalOutput(
    'device-a',
    'session-a',
    3,
    { encoding: 'base64', data: 'dGVzdA==' },
  );

  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.code, 'conflict');
});

test('allows mixed terminal and tool events only for structured sessions', () => {
  assert.equal(canAppendSessionEvent('terminal', 'terminal.output'), true);
  assert.equal(canAppendSessionEvent('terminal', 'tool.event'), false);
  assert.equal(canAppendSessionEvent('structured', 'terminal.output'), true);
  assert.equal(canAppendSessionEvent('structured', 'tool.event'), true);
});

test('publishes accepted terminal events to realtime listeners', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const service = makeService(workspaces, sessions);
  const received: number[] = [];
  const unsubscribe = service.subscribe((notification) => {
    received.push(notification.event.seq);
  });

  await service.appendTerminalOutput('device-a', 'session-a', 1, {
    encoding: 'base64',
    data: 'dGVzdA==',
  });
  unsubscribe();

  assert.deepEqual(received, [1]);
});

test('accepts a local session end and publishes its new state', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const service = makeService(workspaces, sessions);
  const statuses: string[] = [];
  service.subscribeState((session) => statuses.push(session.status));

  const result = await service.finishReportedSession('device-a', 'session-a', {
    status: 'finished',
    finishedAt: new Date(2_000).toISOString(),
  });

  assert.deepEqual(result, { status: 'accepted' });
  assert.deepEqual(statuses, ['finished']);
});

test('finishes stale sessions on startup and when a device disconnects', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const registry = new FakeRegistry();
  const service = makeService(workspaces, sessions, registry);

  await service.onModuleInit();
  registry.publishOffline('device-a', '2026-09-11T10:00:00.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  await service.onModuleDestroy();

  assert.equal(sessions.finishedAll, 1);
  assert.deepEqual(sessions.finishedDevices, ['device-a']);
});

test('delegates finished session deletion after queued writes settle', async () => {
  const workspaces = new FakeWorkspaceRepository();
  const sessions = new FakeSessionRepository();
  const service = makeService(workspaces, sessions);

  assert.equal(await service.deleteFinished('session-a', true), 'deleted');
  assert.deepEqual(sessions.deletions, [{ id: 'session-a', purge: true }]);
});

function makeService(
  workspaces: FakeWorkspaceRepository,
  sessions: FakeSessionRepository,
  registry = new FakeRegistry(),
): SessionsService {
  const devices = {
    findById: async (id: string) => (id === 'device-a' ? { id } : undefined),
  } as unknown as DevicesService;
  return new SessionsService(
    devices,
    registry as unknown as DeviceConnectionRegistry,
    workspaces as unknown as WorkspaceRepository,
    sessions as unknown as SessionRepository,
  );
}

class FakeWorkspaceRepository {
  readonly enabled = true;
  private readonly records = new Map<string, WorkspaceEntity>();

  async register(
    deviceId: string,
    payload: {
      workspaceId: string;
      displayName: string;
      available: boolean;
      remoteStartAllowed: boolean;
    },
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.records.set(payload.workspaceId, {
      id: payload.workspaceId,
      deviceId,
      displayName: payload.displayName,
      available: payload.available,
      remoteStartAllowed: payload.remoteStartAllowed,
    } as WorkspaceEntity);
    return 'accepted' as const;
  }

  async findById(id: string): Promise<WorkspaceEntity | null> {
    return this.records.get(id) ?? null;
  }
}

class FakeSessionRepository {
  readonly enabled = true;
  readonly registrations: string[] = [];
  readonly finishedDevices: string[] = [];
  readonly deletions: Array<{ id: string; purge: boolean }> = [];
  finishedAll = 0;
  outputResult:
    | {
        status: 'accepted';
        event: {
          seq: number;
          type: string;
          payload: Record<string, unknown>;
          createdAt: string;
        };
      }
    | { status: 'conflict'; detail: string } = acceptedEvent(1);

  async registerStarted(
    _deviceId: string,
    sessionId: string,
  ) {
    this.registrations.push(sessionId);
    return acceptedEvent(0, 'session.started');
  }

  async appendTerminalOutput() {
    return this.outputResult;
  }

  async finishAllActive() {
    this.finishedAll += 1;
  }

  async finishActiveForDevice(deviceId: string) {
    this.finishedDevices.push(deviceId);
  }

  async finishById(id: string, finishedAt = new Date(), status = 'finished') {
    return this.record(id, status as 'finished' | 'failed', finishedAt);
  }

  async deleteFinished(id: string, purge: boolean) {
    this.deletions.push({ id, purge });
    return 'deleted' as const;
  }

  async list() {
    return [];
  }

  async findById(id: string) {
    return id === 'session-a' ? this.record(id, 'running') : undefined;
  }

  async listEvents() {
    return [];
  }

  private record(
    id: string,
    status: 'running' | 'finished' | 'failed',
    finishedAt?: Date,
  ) {
    return {
      id,
      deviceId: 'device-a',
      workspaceId: 'workspace-a',
      toolKey: 'shell',
      displayName: null,
      runtimeMode: 'terminal' as const,
      status,
      stateVersion: 1,
      startedAt: new Date(1_000).toISOString(),
      finishedAt: finishedAt?.toISOString() ?? null,
      createdAt: new Date(1_000).toISOString(),
      updatedAt: (finishedAt ?? new Date(1_000)).toISOString(),
    };
  }
}

class FakeRegistry {
  private listener?: (snapshot: {
    deviceId: string;
    presence: 'offline';
    disconnectedAt: string;
  }) => void;

  subscribe(listener: typeof this.listener): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  publishOffline(deviceId: string, disconnectedAt: string): void {
    this.listener?.({ deviceId, presence: 'offline', disconnectedAt });
  }
}

function acceptedEvent(seq: number, type = 'terminal.output') {
  return {
    status: 'accepted' as const,
    event: {
      seq,
      type,
      payload: {},
      createdAt: new Date(1_000 + seq).toISOString(),
    },
  };
}
