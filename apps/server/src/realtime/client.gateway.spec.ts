import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type WebSocket from 'ws';
import { ClientGateway } from './client.gateway';
import { DeviceConnectionRegistry } from './device-connection.registry';
import { ProtocolValidator } from './protocol-validator';

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

function makeGateway() {
  const registry = new DeviceConnectionRegistry();
  return {
    registry,
    gateway: new ClientGateway(new ProtocolValidator(), registry),
  };
}

function envelope(
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

interface SentMessage {
  event: string;
  data: {
    type: string;
    deviceId: string;
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
