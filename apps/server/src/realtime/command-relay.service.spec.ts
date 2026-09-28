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
