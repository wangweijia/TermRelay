import assert from 'node:assert/strict';
import test from 'node:test';
import type { DevicesService } from '../devices/devices.service';
import type { SessionRepository } from './session.repository';
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

function makeService(
  workspaces: FakeWorkspaceRepository,
  sessions: FakeSessionRepository,
): SessionsService {
  const devices = {
    findById: async (id: string) => (id === 'device-a' ? { id } : undefined),
  } as unknown as DevicesService;
  return new SessionsService(
    devices,
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

  async list() {
    return [];
  }

  async findById() {
    return undefined;
  }

  async listEvents() {
    return [];
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
