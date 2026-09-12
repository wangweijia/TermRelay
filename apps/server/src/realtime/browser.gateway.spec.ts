import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type WebSocket from 'ws';
import type {
  SessionEventRecord,
  SessionRecord,
} from '../sessions/session.repository';
import type {
  SessionEventListener,
  SessionStateListener,
  SessionsService,
} from '../sessions/sessions.service';
import { BrowserGateway } from './browser.gateway';
import { BrowserProtocolValidator } from './browser-protocol-validator';
import type { CommandRelayService } from './command-relay.service';

test('sends a history snapshot then streams new events without duplicates', async () => {
  const sessions = new FakeSessionsService();
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    sessions as unknown as SessionsService,
  );
  const socket = new FakeSocket();
  gateway.onModuleInit();
  gateway.handleConnection(socket.asWebSocket());

  await gateway.handleMessage(
    socket.asWebSocket(),
    envelope('session.subscribe', { afterSeq: -1 }),
  );
  assert.equal(socket.messages[0]?.data.type, 'session.subscribed');
  assert.deepEqual(
    socket.messages[0]?.data.payload.events.map(
      (sessionEvent: SessionEventRecord) => sessionEvent.seq,
    ),
    [0, 1],
  );

  sessions.publish(event(2, 'dHdv'));
  sessions.publish(event(2, 'dHdv'));
  assert.equal(socket.messages[1]?.data.type, 'terminal.output');
  assert.equal(socket.messages[1]?.data.seq, 2);
  assert.equal(socket.messages.length, 2);

  await gateway.handleMessage(
    socket.asWebSocket(),
    envelope('session.unsubscribe', {}),
  );
  sessions.publish(event(3, 'dGhyZWU='));
  assert.equal(socket.messages[2]?.data.type, 'session.unsubscribed');
  assert.equal(socket.messages.length, 3);
  gateway.onModuleDestroy();
});

test('buffers live events while the history snapshot is loading', async () => {
  const sessions = new FakeSessionsService();
  let releaseHistory: (() => void) | undefined;
  sessions.beforeHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    sessions as unknown as SessionsService,
  );
  const socket = new FakeSocket();
  gateway.onModuleInit();
  gateway.handleConnection(socket.asWebSocket());

  const subscribing = gateway.handleMessage(
    socket.asWebSocket(),
    envelope('session.subscribe', { afterSeq: 1 }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  sessions.publish(event(2, 'dHdv'));
  releaseHistory?.();
  await subscribing;

  assert.equal(socket.messages[0]?.data.type, 'session.subscribed');
  assert.equal(socket.messages[1]?.data.seq, 2);
  gateway.onModuleDestroy();
});

test('rejects subscriptions for mismatched sessions', async () => {
  const sessions = new FakeSessionsService();
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    sessions as unknown as SessionsService,
  );
  const socket = new FakeSocket();
  gateway.onModuleInit();
  gateway.handleConnection(socket.asWebSocket());

  await gateway.handleMessage(socket.asWebSocket(), {
    ...envelope('session.subscribe', {}),
    deviceId: 'other-device',
  });
  assert.equal(socket.messages[0]?.data.type, 'protocol.error');
  assert.equal(socket.messages[0]?.data.payload.code, 'unknown_session');
  gateway.onModuleDestroy();
});

test('routes validated terminal commands through the command relay', async () => {
  const sessions = new FakeSessionsService();
  const commands = new FakeCommands();
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    sessions as unknown as SessionsService,
    commands as unknown as CommandRelayService,
  );
  const socket = new FakeSocket();
  gateway.handleConnection(socket.asWebSocket());
  const commandId = randomUUID();

  await gateway.handleMessage(socket.asWebSocket(), {
    ...envelope('terminal.input', { encoding: 'base64', data: 'aGk=' }),
    commandId,
  });

  assert.deepEqual(commands.routed, [commandId]);
});

test('sends WebSocket ping frames to connected browsers', () => {
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    new FakeSessionsService() as unknown as SessionsService,
  );
  const socket = new FakeSocket();
  gateway.handleConnection(socket.asWebSocket());

  (gateway as unknown as { pingBrowsers(): void }).pingBrowsers();

  assert.equal(socket.pings, 1);
});

test('broadcasts session state changes to connected browsers', () => {
  const sessions = new FakeSessionsService();
  const gateway = new BrowserGateway(
    new BrowserProtocolValidator(),
    sessions as unknown as SessionsService,
  );
  const socket = new FakeSocket();
  gateway.onModuleInit();
  gateway.handleConnection(socket.asWebSocket());

  sessions.publishState({
    ...sessions.session,
    status: 'finished',
    finishedAt: new Date(2_000).toISOString(),
  });

  assert.equal(socket.messages[0]?.data.type, 'session.updated');
  assert.equal(socket.messages[0]?.data.payload.session.status, 'finished');
  gateway.onModuleDestroy();
});

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId: 'device-a',
    sessionId: 'session-a',
    sentAt: new Date().toISOString(),
    payload,
  };
}

function event(seq: number, data: string): SessionEventRecord {
  return {
    seq,
    type: 'terminal.output',
    payload: { encoding: 'base64', data },
    createdAt: new Date(1_000 + seq).toISOString(),
  };
}

class FakeSessionsService {
  readonly session: SessionRecord = {
    id: 'session-a',
    deviceId: 'device-a',
    workspaceId: 'workspace-a',
    toolKey: 'codex',
    displayName: 'API 调试',
    runtimeMode: 'terminal',
    status: 'running',
    stateVersion: 1,
    startedAt: new Date(1_000).toISOString(),
    finishedAt: null,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
  };
  beforeHistory?: Promise<void>;
  private listener?: SessionEventListener;
  private stateListener?: SessionStateListener;

  subscribe(listener: SessionEventListener): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  subscribeState(listener: SessionStateListener): () => void {
    this.stateListener = listener;
    return () => {
      this.stateListener = undefined;
    };
  }

  async findById(id: string): Promise<SessionRecord | undefined> {
    return id === this.session.id ? this.session : undefined;
  }

  async listEvents(
    _sessionId: string,
    afterSeq: number,
  ): Promise<SessionEventRecord[]> {
    await this.beforeHistory;
    return [
      {
        seq: 0,
        type: 'session.started',
        payload: {},
        createdAt: new Date(1_000).toISOString(),
      },
      event(1, 'b25l'),
    ].filter((item) => item.seq > afterSeq);
  }

  publish(sessionEvent: SessionEventRecord): void {
    this.listener?.({
      deviceId: this.session.deviceId,
      sessionId: this.session.id,
      event: sessionEvent,
    });
  }

  publishState(session: SessionRecord): void {
    this.stateListener?.(session);
  }
}

class FakeCommands {
  readonly routed: string[] = [];

  async route(_client: WebSocket, command: { commandId?: string }) {
    this.routed.push(command.commandId!);
    return { ok: true as const };
  }
}

interface SentMessage {
  event: string;
  data: {
    type: string;
    seq?: number;
    payload: Record<string, any>;
  };
}

class FakeSocket {
  readonly messages: SentMessage[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  pings = 0;

  ping(): void {
    this.pings += 1;
  }

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
