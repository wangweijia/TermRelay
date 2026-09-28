import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type WebSocket from 'ws';
import { ClientGateway } from './client.gateway';
import { DeviceConnectionRegistry } from './device-connection.registry';
import { ProtocolValidator } from './protocol-validator';
import type { SessionsService } from '../sessions/sessions.service';
import type { CommandRelayService } from './command-relay.service';
import { ClientConnectionAuthorizations } from '../client-auth/client-connection-authorizations';
import type {
  SessionStartedPayload,
  SessionEndedPayload,
  TerminalOutputPayload,
  WorkspaceRegisteredPayload,
} from '@termrelay/contracts';

test('registers a client, acknowledges registration, and accepts heartbeats', () => {
  const { gateway, registry } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);

  gateway.handleMessage(
    client,
    envelope('device-a', 'device.register', {
      name: 'Development Mac',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: ['codex'],
    }),
  );

  assert.equal(registry.getConnectionState(client), 'registered');
  assert.equal(registry.getDevice('device-a')?.presence, 'online');
  const acknowledgement = socket.messages[0];
  assert.equal(acknowledgement?.event, 'message');
  assert.equal(acknowledgement?.data.type, 'device.registered');
  assert.equal(acknowledgement?.data.deviceId, 'device-a');
  assert.equal(
    acknowledgement?.data.payload.heartbeatTimeoutMs,
    registry.heartbeatTimeoutMs,
  );

  gateway.handleMessage(
    client,
    envelope('device-a', 'device.heartbeat', {
      connectionState: 'connected',
      activeSessionCount: 2,
    }),
  );
  assert.equal(registry.getDevice('device-a')?.activeSessionCount, 2);
  assert.equal(socket.closed.length, 0);
});

test('rejects heartbeat before registration', () => {
  const { gateway } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);

  gateway.handleMessage(
    client,
    envelope('device-a', 'device.heartbeat', { connectionState: 'connected' }),
  );

  assert.equal(socket.messages[0]?.data.type, 'protocol.error');
  assert.equal(socket.messages[0]?.data.payload.code, 'unknown_device');
  assert.equal(socket.closed[0]?.code, 1008);
});

test('rejects registration that does not match the authenticated device', () => {
  const { gateway, authorizations } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  authorizations.attach(client, {
    credentialId: 'credential-a',
    deviceId: 'device-a',
    expiresAt: null,
  });
  gateway.handleConnection(client);

  gateway.handleMessage(client, envelope('device-b', 'device.register', {
    name: 'Development Mac', appVersion: '0.1.0', platform: 'macOS', tools: ['shell'],
  }));

  assert.equal(socket.messages[0]?.data.payload.code, 'unknown_device');
  assert.equal(socket.closed[0]?.code, 1008);
});

test('reports invalid payloads without registering the client', () => {
  const { gateway, registry } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);

  gateway.handleMessage(
    client,
    envelope('device-a', 'device.register', {
      name: '',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: [],
    }),
  );

  assert.equal(registry.getConnectionState(client), 'connected');
  assert.equal(socket.messages[0]?.data.payload.code, 'invalid_message');
  assert.equal(socket.closed.length, 0);
});

test('closes unsupported protocol versions with code 1002', () => {
  const { gateway } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  const message = envelope('device-a', 'device.heartbeat', {
    connectionState: 'connected',
  });
  message.protocolVersion = '999';

  gateway.handleMessage(client, message);

  assert.equal(socket.messages[0]?.data.payload.code, 'unsupported_version');
  assert.equal(socket.closed[0]?.code, 1002);
});

test('routes registered workspace and session events to the session service', async () => {
  const { gateway, sessions } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  gateway.handleMessage(
    client,
    envelope('device-a', 'device.register', {
      name: 'Development Mac',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: ['codex'],
    }),
  );

  await gateway.handleMessage(
    client,
    envelope('device-a', 'workspace.registered', {
      workspaceId: 'workspace-a',
      displayName: 'Workspace A',
      available: true,
      remoteStartAllowed: false,
    }),
  );
  await gateway.handleMessage(
    client,
    contextualEnvelope('device-a', 'session-a', 0, 'session.started', {
      workspaceId: 'workspace-a',
      toolKey: 'codex',
      displayName: '后端服务',
      runtimeMode: 'pty',
      startedAt: new Date().toISOString(),
    }),
  );
  await gateway.handleMessage(
    client,
    contextualEnvelope('device-a', 'session-a', 1, 'terminal.output', {
      encoding: 'base64',
      data: Buffer.from('hello').toString('base64'),
    }),
  );
  await gateway.handleMessage(
    client,
    {
      ...envelope('device-a', 'session.ended', {
        status: 'finished',
        finishedAt: new Date().toISOString(),
      }),
      sessionId: 'session-a',
    },
  );

  assert.deepEqual(sessions.calls, [
    'workspace:workspace-a',
    'session:session-a',
    'output:session-a:1',
    'ended:session-a:finished',
  ]);
  assert.equal(socket.closed.length, 0);
  assert.equal(
    socket.messages.some((message) =>
      message.data.type === 'session.synced'
      && message.data.payload.lastAcceptedSeq === 0),
    true,
  );
});

test('persists auto-approve changes and returns them on explicit sync', async () => {
  const { gateway, sessions } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  gateway.handleMessage(client, envelope('device-a', 'device.register', {
    name: 'Development Mac', appVersion: '0.1.0', platform: 'macOS', tools: ['shell'],
  }));

  await gateway.handleMessage(client, {
    ...envelope('device-a', 'session.sync', { autoApproveEnabled: true }),
    sessionId: 'session-a',
  });

  assert.equal(socket.messages.at(-1)?.data.type, 'session.synced');
  assert.equal(socket.messages.at(-1)?.data.payload.lastAcceptedSeq, 0);
  assert.equal(socket.messages.at(-1)?.data.payload.autoApproveEnabled, true);
  assert.equal(sessions.autoApproveEnabled, true);
});

test('returns structured sequence recovery context on a gap', async () => {
  const { gateway, sessions } = makeGateway();
  sessions.outputResult = {
    status: 'error', code: 'conflict', detail: 'sequence gap', expectedSeq: 2,
  };
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  gateway.handleMessage(client, envelope('device-a', 'device.register', {
    name: 'Development Mac', appVersion: '0.1.0', platform: 'macOS', tools: ['shell'],
  }));

  await gateway.handleMessage(
    client,
    contextualEnvelope('device-a', 'session-a', 3, 'terminal.output', {
      encoding: 'base64', data: Buffer.from('gap').toString('base64'),
    }),
  );

  const error = socket.messages.at(-1)?.data;
  assert.ok(error);
  assert.equal(error.type, 'protocol.error');
  assert.equal(error.sessionId, 'session-a');
  assert.equal(error.payload.expectedSeq, 2);
});

test('routes command acknowledgements from a registered Mac', async () => {
  const { gateway, commands } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  gateway.handleMessage(client, envelope('device-a', 'device.register', {
    name: 'Development Mac', appVersion: '0.1.0', platform: 'macOS', tools: ['shell'],
  }));
  const commandId = randomUUID();
  await gateway.handleMessage(client, {
    ...envelope('device-a', 'command.ack', { commandId, status: 'completed' }),
    sessionId: 'session-a',
    commandId,
  });
  assert.deepEqual(commands.acknowledged, [commandId]);
});

test('lists only owned Copilot history in bounded pages on a registered connection', async () => {
    const { gateway, sessions } = makeGateway();
    const socket = new FakeSocket();
    const client = socket.asWebSocket();
    gateway.handleConnection(client);
    await gateway.handleMessage(client, envelope('device-a', 'session.history.list', {}));
    assert.equal(socket.messages.at(-1)?.data.payload.code, 'unknown_device');
    assert.equal(socket.closed.at(-1)?.code, 1008);

    const registeredSocket = new FakeSocket();
    const registeredClient = registeredSocket.asWebSocket();
    gateway.handleConnection(registeredClient);
    await gateway.handleMessage(registeredClient, envelope('device-a', 'device.register', {
      name: 'Mac', appVersion: '1', platform: 'macOS', tools: ['copilot'],
    }));
    sessions.historySessions = Array.from({ length: 101 }, (_, index) => ({
      id: `session-${String(100 - index).padStart(3, '0')}`, deviceId: 'device-a', workspaceId: 'workspace-a',
      toolKey: 'copilot', displayName: null, runtimeMode: 'acp', status: 'finished',
      startedAt: null, updatedAt: new Date().toISOString(),
    }));
    const firstRequest = envelope('device-a', 'session.history.list', {});
    await gateway.handleMessage(registeredClient, firstRequest);
    assert.equal(registeredSocket.messages.at(-1)?.data.type, 'session.history.listed');
    assert.equal((registeredSocket.messages.at(-1)?.data.payload.sessions as unknown[]).length, 100);
    assert.equal(registeredSocket.messages.at(-1)?.data.payload.hasMore, true);
    assert.equal(registeredSocket.messages.at(-1)?.data.payload.relatedMessageId, firstRequest.messageId);
    const nextCursor = registeredSocket.messages.at(-1)?.data.payload.nextCursor;
    assert.equal(typeof nextCursor, 'string');
    assert.deepEqual(sessions.lastHistoryQuery, ['device-a', undefined, 101]);
    await gateway.handleMessage(registeredClient, envelope('device-a', 'session.history.list', { cursor: nextCursor }));
    assert.equal((registeredSocket.messages.at(-1)?.data.payload.sessions as unknown[]).length, 1);
    assert.equal((registeredSocket.messages.at(-1)?.data.payload.sessions as Array<{ id: string }>)[0]?.id, 'session-000');
    assert.equal(registeredSocket.messages.at(-1)?.data.payload.hasMore, false);
    assert.equal(registeredSocket.messages.at(-1)?.data.payload.nextCursor, undefined);
    assert.equal(sessions.lastHistoryQuery?.[1]?.id, 'session-001');
    await gateway.handleMessage(registeredClient, envelope('device-a', 'session.history.list', {
      cursor: 'YWJj.ZGVm',
    }));
    assert.equal(registeredSocket.messages.at(-1)?.data.payload.code, 'invalid_message');
  });

test('returns owned Copilot events oldest-first with a bounded reverse cursor', async () => {
    const { gateway, sessions } = makeGateway();
    const socket = new FakeSocket();
    const client = socket.asWebSocket();
    gateway.handleConnection(client);
    await gateway.handleMessage(client, envelope('device-a', 'device.register', {
      name: 'Mac', appVersion: '1', platform: 'macOS', tools: ['copilot'],
    }));
    sessions.historyEvents = Array.from({ length: 4 }, (_, seq) => ({
      seq, type: 'tool.event', payload: { value: seq }, createdAt: new Date().toISOString(),
    }));
    const request = {
      ...envelope('device-a', 'session.history.request', { limit: 2 }),
      sessionId: 'session-a',
    };
    await gateway.handleMessage(client, request);
    assert.deepEqual((socket.messages.at(-1)?.data.payload.events as Array<{ seq: number }>).map((e) => e.seq), [2, 3]);
    assert.equal(socket.messages.at(-1)?.data.payload.hasMore, true);
    assert.equal(socket.messages.at(-1)?.data.sessionId, 'session-a');
    assert.equal(socket.messages.at(-1)?.data.payload.relatedMessageId, request.messageId);
    assert.deepEqual(sessions.lastEventsQuery, ['session-a', undefined, 3]);
    await gateway.handleMessage(client, { ...request, payload: { beforeSeq: 2, limit: 2 } });
    assert.deepEqual((socket.messages.at(-1)?.data.payload.events as Array<{ seq: number }>).map((e) => e.seq), [0, 1]);
    assert.equal(socket.messages.at(-1)?.data.payload.hasMore, false);

    await gateway.handleMessage(client, { ...request, sessionId: 'not-owned' });
    assert.equal(socket.messages.at(-1)?.data.payload.code, 'unknown_session');
    assert.equal(socket.messages.at(-1)?.data.payload.relatedMessageId, request.messageId);
    sessions.historyEvents = [0, 1].map((seq) => ({
      seq, type: 'tool.event', payload: { text: 'x'.repeat(1_100_000) },
      createdAt: new Date().toISOString(),
    }));
    await gateway.handleMessage(client, request);
    assert.deepEqual((socket.messages.at(-1)?.data.payload.events as Array<{ seq: number }>).map((e) => e.seq), [1]);
    assert.equal(socket.messages.at(-1)?.data.payload.hasMore, true);
    sessions.historyEvents = [{
      seq: 0, type: 'tool.event', payload: { text: 'x'.repeat(2_000_000) },
      createdAt: new Date().toISOString(),
    }];
    await gateway.handleMessage(client, request);
    assert.equal(socket.messages.at(-1)?.data.payload.code, 'conflict');
  });

test('deletes only owned finished Copilot history with the requested purge mode', async () => {
  const { gateway, sessions } = makeGateway();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();
  gateway.handleConnection(client);
  await gateway.handleMessage(client, envelope('device-a', 'device.register', {
    name: 'Mac', appVersion: '1', platform: 'macOS', tools: ['copilot'],
  }));

  const request = { ...envelope('device-a', 'session.history.delete', { purge: false }), sessionId: 'session-a' };
  await gateway.handleMessage(client, request);
  assert.deepEqual(sessions.deletions, [{ id: 'session-a', purge: false }]);
  assert.equal(socket.messages.at(-1)?.data.type, 'session.history.deleted');
  assert.equal(socket.messages.at(-1)?.data.payload.relatedMessageId, request.messageId);
  assert.equal(socket.messages.at(-1)?.data.payload.purged, false);

  await gateway.handleMessage(client, { ...request, payload: { purge: true } });
  assert.deepEqual(sessions.deletions.at(-1), { id: 'session-a', purge: true });
  await gateway.handleMessage(client, { ...request, sessionId: 'not-owned' });
  assert.equal(socket.messages.at(-1)?.data.payload.code, 'unknown_session');
  assert.equal(sessions.deletions.length, 2);

  sessions.deletionResult = 'not_finished';
  await gateway.handleMessage(client, request);
  assert.equal(socket.messages.at(-1)?.data.payload.code, 'conflict');
  await gateway.handleMessage(client, { ...request, payload: { purge: 'true' } });
  assert.equal(socket.messages.at(-1)?.data.payload.code, 'invalid_message');
  assert.equal(sessions.deletions.length, 3);

  const otherSocket = new FakeSocket();
  const otherClient = otherSocket.asWebSocket();
  gateway.handleConnection(otherClient);
  await gateway.handleMessage(otherClient, envelope('device-b', 'device.register', {
    name: 'Other Mac', appVersion: '1', platform: 'macOS', tools: ['copilot'],
  }));
  await gateway.handleMessage(otherClient, { ...request, deviceId: 'device-b' });
  assert.equal(otherSocket.messages.at(-1)?.data.payload.code, 'unknown_session');
  assert.equal(sessions.deletions.length, 3);
});

function makeGateway() {
  const registry = new DeviceConnectionRegistry();
  const sessions = new FakeSessionsService();
  const commands = new FakeCommands();
  const authorizations = new ClientConnectionAuthorizations();
  return {
    registry,
    sessions,
    commands,
    authorizations,
    gateway: new ClientGateway(
      new ProtocolValidator(),
      registry,
      sessions as unknown as SessionsService,
      commands as unknown as CommandRelayService,
      authorizations,
    ),
  };
}

class FakeCommands {
  readonly acknowledged: string[] = [];

  async acknowledge(
    _client: WebSocket,
    envelope: { commandId?: string },
  ): Promise<'acknowledged'> {
    this.acknowledged.push(envelope.commandId!);
    return 'acknowledged';
  }
}

function envelope(
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    type,
    protocolVersion: '2',
    messageId: randomUUID(),
    deviceId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

function contextualEnvelope(
  deviceId: string,
  sessionId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return { ...envelope(deviceId, type, payload), sessionId, seq };
}

class FakeSessionsService {
  readonly calls: string[] = [];
  historySessions: Array<{
    id: string; deviceId: string; workspaceId: string; toolKey: string;
    displayName: string | null; runtimeMode: 'acp'; status: 'finished';
    startedAt: string | null; updatedAt: string;
  }> = [];
  historyEvents: Array<{ seq: number; type: string; payload: Record<string, unknown>; createdAt: string }> = [];
  lastHistoryQuery?: [string, { updatedAt: Date; id: string } | undefined, number];
  lastEventsQuery?: [string, number | undefined, number];
  outputResult:
    | { status: 'accepted' }
    | { status: 'error'; code: 'conflict'; detail: string; expectedSeq: number } = {
      status: 'accepted',
    };
  autoApproveEnabled = false;
  deletions: Array<{ id: string; purge: boolean }> = [];
  deletionResult: 'deleted' | 'not_finished' | 'not_found' = 'deleted';

  async deleteFinished(id: string, purge: boolean) {
    this.deletions.push({ id, purge });
    return this.deletionResult;
  }

  async registerWorkspace(
    _deviceId: string,
    payload: WorkspaceRegisteredPayload,
  ) {
    this.calls.push(`workspace:${payload.workspaceId}`);
    return { status: 'accepted' as const };
  }

  async finishReportedSession(
    _deviceId: string,
    sessionId: string,
    payload: SessionEndedPayload,
  ) {
    this.calls.push(`ended:${sessionId}:${payload.status}`);
    return { status: 'accepted' as const };
  }

  async registerSession(
    _deviceId: string,
    sessionId: string,
    _payload: SessionStartedPayload,
  ) {
    this.calls.push(`session:${sessionId}`);
    return { status: 'accepted' as const };
  }

  async appendTerminalOutput(
    _deviceId: string,
    sessionId: string,
    seq: number,
    _payload: TerminalOutputPayload,
  ) {
    this.calls.push(`output:${sessionId}:${seq}`);
    return this.outputResult;
  }

  async findOwnedSession(deviceId: string, sessionId: string) {
    if (deviceId !== 'device-a' || sessionId !== 'session-a') return undefined;
    return {
      id: sessionId,
      deviceId,
      stateVersion: 0,
      autoApproveEnabled: this.autoApproveEnabled,
      toolKey: 'copilot',
      runtimeMode: 'acp',
    };
  }

  async listCopilotHistoryForDevice(
    deviceId: string, cursor: { updatedAt: Date; id: string } | undefined, limit: number,
  ) {
    this.lastHistoryQuery = [deviceId, cursor, limit];
    return this.historySessions
      .filter((session) => !cursor
        || session.updatedAt < cursor.updatedAt.toISOString()
        || (session.updatedAt === cursor.updatedAt.toISOString() && session.id < cursor.id))
      .slice(0, limit);
  }

  async listEventsBefore(sessionId: string, beforeSeq: number | undefined, limit: number) {
    this.lastEventsQuery = [sessionId, beforeSeq, limit];
    return this.historyEvents
      .filter((event) => beforeSeq === undefined || event.seq < beforeSeq)
      .slice(-limit);
  }

  async setAutoApprove(sessionId: string, enabled: boolean, deviceId?: string) {
    if (sessionId !== 'session-a' || (deviceId && deviceId !== 'device-a')) return undefined;
    this.autoApproveEnabled = enabled;
    return this.findOwnedSession('device-a', sessionId);
  }
}

interface SentMessage {
  event: string;
  data: {
    type: string;
    deviceId: string;
    sessionId?: string;
    payload: Record<string, unknown>;
  };
}

class FakeSocket {
  readonly messages: SentMessage[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as SentMessage);
  }

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
