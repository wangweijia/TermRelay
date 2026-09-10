import assert from 'node:assert/strict';
import test from 'node:test';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from './device-connection.registry';

test('registers a device, updates heartbeats, and marks disconnect offline', () => {
  const registry = new DeviceConnectionRegistry();
  const socket = new FakeSocket();
  const client = socket.asWebSocket();

  registry.connect(client, 1_000);
  const registered = registry.register(client, 'device-a', registration(), 2_000);

  assert.equal(registry.getConnectionState(client), 'registered');
  assert.equal(registry.getClient('device-a'), client);
  assert.equal(registered.presence, 'online');

  const heartbeat = registry.heartbeat(
    client,
    'device-a',
    { connectionState: 'degraded', activeSessionCount: 3 },
    3_000,
  );
  assert.equal(heartbeat?.connectionState, 'degraded');
  assert.equal(heartbeat?.activeSessionCount, 3);

  registry.disconnect(client, 4_000);
  assert.equal(registry.getClient('device-a'), undefined);
  assert.equal(registry.getDevice('device-a')?.presence, 'offline');
  assert.equal(registry.getDevice('device-a')?.disconnectedAt, new Date(4_000).toISOString());
});

test('a newer connection replaces the previous connection for the same device', () => {
  const registry = new DeviceConnectionRegistry();
  const first = new FakeSocket();
  const second = new FakeSocket();

  registry.connect(first.asWebSocket(), 0);
  registry.register(first.asWebSocket(), 'device-a', registration(), 1);
  registry.connect(second.asWebSocket(), 2);
  registry.register(second.asWebSocket(), 'device-a', registration(), 3);

  assert.deepEqual(first.closed, [
    { code: 4000, reason: 'replaced by a newer device connection' },
  ]);
  assert.equal(registry.getClient('device-a'), second.asWebSocket());

  registry.disconnect(first.asWebSocket(), 4);
  assert.equal(registry.getDevice('device-a')?.presence, 'online');
});

test('expires unregistered and heartbeat-stale connections', () => {
  const registry = new DeviceConnectionRegistry();
  const unregistered = new FakeSocket();
  registry.connect(unregistered.asWebSocket(), 0);

  const registrationExpiry = registry.expireStaleConnections(
    registry.registrationTimeoutMs,
  );
  assert.deepEqual(registrationExpiry, [{ reason: 'registration_timeout' }]);
  assert.equal(unregistered.closed[0]?.code, 4001);

  const stale = new FakeSocket();
  registry.connect(stale.asWebSocket(), 100);
  registry.register(stale.asWebSocket(), 'device-stale', registration(), 200);
  const heartbeatExpiry = registry.expireStaleConnections(
    200 + registry.heartbeatTimeoutMs,
  );

  assert.deepEqual(heartbeatExpiry, [
    { reason: 'heartbeat_timeout', deviceId: 'device-stale' },
  ]);
  assert.equal(stale.closed[0]?.code, 4002);
  assert.equal(registry.getDevice('device-stale')?.presence, 'offline');
});

function registration() {
  return {
    name: 'Development Mac',
    appVersion: '0.1.0',
    platform: 'macOS' as const,
    tools: ['codex'],
  };
}

class FakeSocket {
  readonly closed: Array<{ code: number; reason: string }> = [];

  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}
