import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const endpoint = process.env.SERVER_WS_URL ?? 'ws://127.0.0.1:3007/ws/client';
const timeoutMs = 3_000;

await probeRegistrationAndHeartbeat();
await probeUnregisteredHeartbeat();
await probeUnsupportedVersion();
console.log('Server S1 WebSocket probe passed.');

async function probeRegistrationAndHeartbeat() {
  const socket = await connect();
  socket.send(
    wireMessage(
      envelope('probe-device', 'device.register', {
        name: 'S1 Probe Mac',
        appVersion: '0.1.0',
        platform: 'macOS',
        tools: ['codex', 'shell'],
      }),
    ),
  );

  const response = await nextMessage(socket);
  assert(response.data?.type === 'device.registered', 'expected device.registered');
  assert(
    response.data?.payload?.heartbeatTimeoutMs > 0,
    'expected heartbeat timeout configuration',
  );

  socket.send(
    wireMessage(
      envelope('probe-device', 'device.heartbeat', {
        connectionState: 'connected',
        activeSessionCount: 2,
      }),
    ),
  );
  socket.close(1000, 'registration probe complete');
  await nextClose(socket, 1000);
  console.log('✓ registration acknowledgement and heartbeat');
}

async function probeUnregisteredHeartbeat() {
  const socket = await connect();
  socket.send(
    wireMessage(
      envelope('unregistered-probe', 'device.heartbeat', {
        connectionState: 'connected',
      }),
    ),
  );

  const response = await nextMessage(socket);
  assert(response.data?.type === 'protocol.error', 'expected protocol.error');
  assert(response.data?.payload?.code === 'unknown_device', 'expected unknown_device');
  await nextClose(socket, 1008);
  console.log('✓ unregistered heartbeat rejected');
}

async function probeUnsupportedVersion() {
  const socket = await connect();
  socket.send(
    wireMessage({
      ...envelope('version-probe', 'device.heartbeat', {
        connectionState: 'connected',
      }),
      protocolVersion: '999',
    }),
  );

  const response = await nextMessage(socket);
  assert(response.data?.type === 'protocol.error', 'expected protocol.error');
  assert(
    response.data?.payload?.code === 'unsupported_version',
    'expected unsupported_version',
  );
  await nextClose(socket, 1002);
  console.log('✓ unsupported protocol version rejected');
}

function envelope(deviceId, type, payload) {
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
      const socket = new WebSocket(endpoint);
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
        if (code !== expectedCode) {
          reject(
            new Error(
              `expected close ${expectedCode}, received ${code} ${reason.toString()}`,
            ),
          );
          return;
        }
        resolve();
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
