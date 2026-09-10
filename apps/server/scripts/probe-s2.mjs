import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const websocketEndpoint =
  process.env.SERVER_WS_URL ?? 'ws://127.0.0.1:3100/ws/client';
const httpEndpoint =
  process.env.SERVER_HTTP_URL ?? 'http://127.0.0.1:3100';
const deviceId = 'probe-s2-device';
const timeoutMs = 3_000;

const socket = await connect();
socket.send(
  wireMessage(
    envelope('device.register', {
      name: 'S2 Persistence Probe Mac',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: ['codex', 'shell'],
    }),
  ),
);

const registration = await nextMessage(socket);
assert(registration.data?.type === 'device.registered', 'expected device.registered');

socket.send(
  wireMessage(
    envelope('device.heartbeat', {
      connectionState: 'connected',
      activeSessionCount: 2,
    }),
  ),
);
socket.close(1000, 'S2 persistence probe complete');
await nextClose(socket, 1000);

const device = await pollForOfflineDevice();
assert(device.name === 'S2 Persistence Probe Mac', 'expected persisted name');
assert(device.status === 'offline', 'expected offline status after disconnect');
assert(device.activeSessionCount === 2, 'expected persisted heartbeat state');
assert(device.tools?.includes('codex'), 'expected persisted capabilities');
assert(device.disconnectedAt, 'expected disconnect timestamp');
assert(
  Date.parse(device.updatedAt) >= Date.parse(device.createdAt),
  'expected updatedAt to be no earlier than createdAt',
);

const listResponse = await fetch(`${httpEndpoint}/api/devices`);
assert(listResponse.ok, `device list returned ${listResponse.status}`);
const devices = await listResponse.json();
assert(
  devices.some((item) => item.id === deviceId),
  'expected probe device in device list',
);

console.log('✓ device register, heartbeat, and disconnect persisted in order');
console.log('✓ device detail and list APIs returned persisted state');
console.log('Server S2 device persistence probe passed.');

async function pollForOfflineDevice() {
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${httpEndpoint}/api/devices/${encodeURIComponent(deviceId)}`,
      );
      if (response.ok) {
        const device = await response.json();
        if (device.status === 'offline') return device;
      } else {
        latestError = new Error(`device detail returned ${response.status}`);
      }
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw latestError ?? new Error(`device did not become offline within ${timeoutMs} ms`);
}

function envelope(type, payload) {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

function wireMessage(data) {
  return JSON.stringify({ event: 'message', data });
}

function connect() {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketEndpoint);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    }),
    'connect',
  );
}

function nextMessage(socket) {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once('message', (data) => {
        try {
          resolve(JSON.parse(data.toString()));
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    }),
    'message',
  );
}

function nextClose(socket, expectedCode) {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once('close', (code, reason) => {
        if (code === expectedCode) resolve();
        else reject(new Error(`expected close ${expectedCode}, received ${code} ${reason}`));
      });
      socket.once('error', reject);
    }),
    'close',
  );
}

function withTimeout(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${operation} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
