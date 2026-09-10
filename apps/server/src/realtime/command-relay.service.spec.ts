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
    service.acknowledge(mac.asWebSocket(), {
      ...command,
      type: 'command.ack',
      payload: { commandId, status: 'completed' },
    }),
    true,
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
    service.acknowledge(mac.asWebSocket(), {
      ...command,
      type: 'command.ack',
      payload: { commandId, status: 'completed' },
    }),
    false,
  );
  service.onModuleDestroy();
});

function envelope(
  type: string,
  commandId: string,
  payload: Record<string, unknown>,
): Envelope<Record<string, unknown>> {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId: 'device-a',
    sessionId: 'session-a',
    commandId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

class FakeSessions {
  async findById(id: string) {
    return id === 'session-a'
      ? { id, deviceId: 'device-a', status: 'running' }
      : undefined;
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
