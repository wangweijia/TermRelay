import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Envelope } from '@termrelay/contracts';
import type WebSocket from 'ws';
import type { SessionsService } from '../sessions/sessions.service';
import { CommandRelayService } from './command-relay.service';
import type { DeviceConnectionRegistry } from './device-connection.registry';

test('routes a command to the owning Mac and returns its acknowledgement', async () => {
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const registry = new FakeRegistry(mac);
  const service = new CommandRelayService(
    registry as unknown as DeviceConnectionRegistry,
    new FakeSessions() as unknown as SessionsService,
  );
  const commandId = randomUUID();
  const command = envelope('terminal.input', commandId, {
    encoding: 'base64',
    data: 'aGk=',
  });

  assert.deepEqual(await service.route(browser.asWebSocket(), command), { ok: true });
  assert.equal(mac.messages[0]?.data.type, 'terminal.input');
  assert.equal(
    await service.acknowledge(mac.asWebSocket(), {
      ...command,
      type: 'command.ack',
      commandId: commandId.toUpperCase(),
      payload: { commandId: commandId.toUpperCase(), status: 'completed' },
    }),
    'acknowledged',
  );
  assert.equal(browser.messages[0]?.data.type, 'command.ack');
  assert.equal(browser.messages[0]?.data.payload.status, 'completed');
  service.onModuleDestroy();
});

test('rejects offline devices and mismatched acknowledgements', async () => {
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const registry = new FakeRegistry(undefined);
  const service = new CommandRelayService(
    registry as unknown as DeviceConnectionRegistry,
    new FakeSessions() as unknown as SessionsService,
  );
  const commandId = randomUUID();
  const command = envelope('session.stop', commandId, {});
  const result = await service.route(browser.asWebSocket(), command);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unknown_device');
  assert.equal(
    await service.acknowledge(mac.asWebSocket(), {
      ...command,
      type: 'command.ack',
      payload: { commandId, status: 'completed' },
    }),
    'ignored',
  );
  service.onModuleDestroy();
});

test('marks a stopped session finished after the Mac confirms the command', async () => {
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const sessions = new FakeSessions();
  const service = new CommandRelayService(
    new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    sessions as unknown as SessionsService,
  );
  const commandId = randomUUID();
  const command = envelope('session.stop', commandId, {});

  assert.deepEqual(await service.route(browser.asWebSocket(), command), { ok: true });
  assert.equal(
    await service.acknowledge(mac.asWebSocket(), {
      ...command,
      type: 'command.ack',
      payload: { commandId, status: 'completed' },
    }),
    'acknowledged',
  );
  assert.deepEqual(sessions.finished, ['session-a']);
  service.onModuleDestroy();
});

test('records ACP input before sending it and rejects a stale window', async () => {
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const sessions = new FakeSessions('acp');
  const service = new CommandRelayService(
    new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    sessions as unknown as SessionsService,
  );
  const command = envelope('tool.turn.start', randomUUID(), { text: 'hello' });

  assert.deepEqual(await service.route(browser.asWebSocket(), command), { ok: true });
  assert.deepEqual(sessions.userInputs, ['session-a']);
  assert.equal(mac.messages.length, 1);
  sessions.canRecordInput = false;
  const stale = await service.route(browser.asWebSocket(), envelope('tool.turn.start', randomUUID(), { text: 'again' }));
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'conflict');
  assert.equal(mac.messages.length, 1);
  service.onModuleDestroy();
});

function envelope(
  type: string,
  commandId: string,
  payload: Record<string, unknown>,
): Envelope<Record<string, unknown>> {
  return {
    type,
    protocolVersion: '2',
    messageId: randomUUID(),
    deviceId: 'device-a',
    sessionId: 'session-a',
    commandId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

class FakeSessions {
  readonly finished: string[] = [];
  readonly userInputs: string[] = [];
  canRecordInput = true;

  constructor(private readonly runtimeMode: 'pty' | 'acp' = 'pty') {}

  async findById(id: string) {
    return id === 'session-a'
      ? { id, deviceId: 'device-a', status: 'running', runtimeMode: this.runtimeMode }
      : undefined;
  }

  async markUserMessageIntent(_deviceId: string, id: string): Promise<boolean> {
    this.userInputs.push(id);
    return this.canRecordInput;
  }

  async finishSession(id: string) {
    this.finished.push(id);
  }
}

class FakeRegistry {
  constructor(private readonly mac?: FakeSocket) {}

  getClient(): WebSocket | undefined {
    return this.mac?.asWebSocket();
  }

  isRegisteredClient(client: WebSocket): boolean {
    return client === this.mac?.asWebSocket();
  }
}

class FakeSocket {
  readonly messages: Array<{ event: string; data: Record<string, any> }> = [];

  send(value: string): void {
    this.messages.push(JSON.parse(value));
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

test('late ACK is queryable after timeout and relay restart; the command is never forwarded twice', async context => {
  const { TurnCommandRepository } = await import('./turn-command.repository');
  const { TurnCommandController } = await import('./turn-command.controller');
  const records = new TurnCommandRepository();
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const registry = new FakeRegistry(mac) as unknown as DeviceConnectionRegistry;
  const sessions = new FakeSessions('acp') as unknown as SessionsService;
  const service = new CommandRelayService(registry, sessions, undefined, records);
  const command = envelope('tool.turn.start', randomUUID(), { text: 'hello', attachments: [randomUUID()] });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await service.route(browser.asWebSocket(), command), { ok: true });
  context.mock.timers.tick(15_001);
  assert.equal(browser.messages[0]?.data.payload.errorCode, 'ack_timeout');
  assert.equal((await records.find(command.commandId!))?.ack, null);
  service.onModuleDestroy();
  const restarted = new CommandRelayService(registry, sessions, undefined, records);
  try {
    const ack = { ...command, type: 'command.ack', payload: { commandId: command.commandId!, status: 'completed' as const } };
    assert.equal(await restarted.acknowledge(mac.asWebSocket(), ack), 'acknowledged');
    const controller = new TurnCommandController(sessions, records);
    const result = await controller.find('session-a', command.commandId!);
    assert.equal(result.ack?.status, 'completed');
    assert.equal((await restarted.route(browser.asWebSocket(), command)).ok, false);
    assert.equal((await restarted.route(browser.asWebSocket(), { ...command, payload: { text: 'different' } })).ok, false);
    assert.equal(mac.messages.length, 1);
    await assert.rejects(controller.find('another-session', command.commandId!), { status: 404 });
    // Out-of-order ACKs cannot downgrade the stored terminal result.
    await restarted.acknowledge(mac.asWebSocket(), { ...ack, payload: { commandId: command.commandId!, status: 'accepted' } });
    assert.equal((await controller.find('session-a', command.commandId!)).ack?.status, 'completed');
  } finally { restarted.onModuleDestroy(); }
});

test('unregistered clients and wrong scopes cannot persist a late confirmation', async () => {
  const { TurnCommandRepository } = await import('./turn-command.repository');
  const records = new TurnCommandRepository();
  const mac = new FakeSocket();
  const service = new CommandRelayService(new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    new FakeSessions('acp') as unknown as SessionsService, undefined, records);
  const command = envelope('tool.turn.start', randomUUID(), { text: 'hello' });
  await service.route(new FakeSocket().asWebSocket(), command);
  service.onModuleDestroy();
  const ack = { ...command, type: 'command.ack', payload: { commandId: command.commandId!, status: 'completed' as const } };
  assert.equal(await service.acknowledge(new FakeSocket().asWebSocket(), ack), 'connection_mismatch');
  assert.equal(await service.acknowledge(mac.asWebSocket(), { ...ack, sessionId: 'other' }), 'connection_mismatch');
  assert.equal(await service.acknowledge(mac.asWebSocket(), { ...ack, payload: { ...ack.payload, commandId: randomUUID() } }), 'connection_mismatch');
  assert.equal((await records.find(command.commandId!))?.ack, null);
});

test('a persistence failure stops forwarding and is not presented as a completed send', async () => {
  const { TurnCommandRepository } = await import('./turn-command.repository');
  const records = new TurnCommandRepository();
  records.reserve = async () => { throw new Error('database unavailable'); };
  const mac = new FakeSocket();
  const service = new CommandRelayService(new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    new FakeSessions('acp') as unknown as SessionsService, undefined, records);
  assert.equal((await service.route(new FakeSocket().asWebSocket(), envelope('tool.turn.start', randomUUID(), { text: 'hello' }))).ok, false);
  assert.equal(mac.messages.length, 0);
  service.onModuleDestroy();
});

test('confirmation is not sent to the browser until persistence succeeds', async () => {
  const { TurnCommandRepository } = await import('./turn-command.repository');
  const records = new TurnCommandRepository();
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const service = new CommandRelayService(new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    new FakeSessions('acp') as unknown as SessionsService, undefined, records);
  const command = envelope('tool.turn.start', randomUUID(), { text: 'hello' });
  await service.route(browser.asWebSocket(), command);
  const persist = records.acknowledge.bind(records);
  records.acknowledge = async () => { throw new Error('write unavailable'); };
  const ack = { ...command, type: 'command.ack', payload: { commandId: command.commandId!, status: 'completed' as const } };
  try {
    await assert.rejects(service.acknowledge(mac.asWebSocket(), ack), /write unavailable/);
    assert.equal(browser.messages.length, 0);
    assert.equal((await records.find(command.commandId!))?.ack, null);
    records.acknowledge = persist;
    await service.acknowledge(mac.asWebSocket(), ack);
    assert.equal((await records.find(command.commandId!))?.ack?.status, 'completed');
    assert.equal(browser.messages[0]?.data.payload.status, 'completed');
  } finally { service.onModuleDestroy(); }
});

test('concurrent final ACKs notify the browser with the same first terminal result returned by status queries', async () => {
  const { TurnCommandRepository } = await import('./turn-command.repository');
  const records = new TurnCommandRepository();
  const mac = new FakeSocket();
  const browser = new FakeSocket();
  const service = new CommandRelayService(new FakeRegistry(mac) as unknown as DeviceConnectionRegistry,
    new FakeSessions('acp') as unknown as SessionsService, undefined, records);
  const command = envelope('tool.turn.start', randomUUID(), { text: 'hello' });
  await service.route(browser.asWebSocket(), command);
  const persist = records.acknowledge.bind(records);
  let entered!: () => void;
  let release!: () => void;
  const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  records.acknowledge = async (id, payload) => {
    const result = await persist(id, payload);
    if (payload.status === 'failed') { entered(); await resume; }
    return result;
  };
  const failed = service.acknowledge(mac.asWebSocket(), { ...command, type: 'command.ack',
    payload: { commandId: command.commandId!, status: 'failed', message: 'first final result' } });
  try {
    await enteredWrite;
    await service.acknowledge(mac.asWebSocket(), { ...command, type: 'command.ack',
      payload: { commandId: command.commandId!, status: 'completed' } });
    assert.equal((await records.find(command.commandId!))?.ack?.status, 'failed');
    assert.equal(browser.messages[0]?.data.payload.status, 'failed');
    assert.equal(browser.messages[0]?.data.payload.message, 'first final result');
  } finally { release(); await failed; service.onModuleDestroy(); }
  assert.ok(browser.messages.every(message => message.data.payload.status === 'failed'));
});
