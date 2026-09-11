import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const websocketEndpoint =
  process.env.SERVER_WS_URL ?? 'ws://127.0.0.1:3007/ws/client';
const httpEndpoint = process.env.SERVER_HTTP_URL ?? 'http://127.0.0.1:3007';
const deviceId = 'probe-s3-device';
const workspaceId = 'probe-s3-workspace';
const sessionId = `probe-s3-${randomUUID()}`;
const timeoutMs = 4_000;

const socket = await connect();
socket.send(
  wireMessage(
    envelope('device.register', {
      name: 'S3 Session Probe Mac',
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
    envelope('workspace.registered', {
      workspaceId,
      displayName: 'S3 Probe Workspace',
      available: true,
      remoteStartAllowed: false,
    }),
  ),
);
socket.send(
  wireMessage(
    sessionEnvelope('session.started', 0, {
      workspaceId,
      toolKey: 'codex',
      runtimeMode: 'terminal',
      startedAt: new Date().toISOString(),
    }),
  ),
);

const first = outputPayload('first line\n');
const second = outputPayload('\u001b[32msecond line\u001b[0m\n');
const third = outputPayload('第三行 🚀\n');
socket.send(wireMessage(sessionEnvelope('terminal.output', 1, first)));
socket.send(wireMessage(sessionEnvelope('terminal.output', 2, second)));
socket.send(wireMessage(sessionEnvelope('terminal.output', 2, second)));
socket.send(wireMessage(sessionEnvelope('terminal.output', 4, third)));

const conflict = await nextMessage(socket);
assert(conflict.data?.type === 'protocol.error', 'expected sequence protocol.error');
assert(conflict.data?.payload?.code === 'conflict', 'expected sequence conflict');
assert(
  conflict.data?.payload?.message?.includes('Expected sequence 3'),
  'expected next sequence detail',
);

socket.send(wireMessage(sessionEnvelope('terminal.output', 3, third)));

const session = await pollForSessionVersion(3);
assert(session.deviceId === deviceId, 'expected session device');
assert(session.workspaceId === workspaceId, 'expected session workspace');
assert(session.runtimeMode === 'terminal', 'expected terminal runtime mode');
assert(session.status === 'running', 'expected running session');

const eventsResponse = await fetch(
  `${httpEndpoint}/api/sessions/${encodeURIComponent(sessionId)}/events`,
);
assert(eventsResponse.ok, `session events returned ${eventsResponse.status}`);
const events = await eventsResponse.json();
assert(events.length === 4, `expected 4 deduplicated events, received ${events.length}`);
assert(
  events.map((event) => event.seq).join(',') === '0,1,2,3',
  'expected contiguous event sequence 0,1,2,3',
);
assert(decode(events[1].payload.data) === 'first line\n', 'expected first output');
assert(decode(events[3].payload.data) === '第三行 🚀\n', 'expected UTF-8 output');

const tailResponse = await fetch(
  `${httpEndpoint}/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=1&limit=10`,
);
assert(tailResponse.ok, `session event tail returned ${tailResponse.status}`);
const tail = await tailResponse.json();
assert(tail.map((event) => event.seq).join(',') === '2,3', 'expected event tail');

socket.close(1000, 'S3 session probe complete');
await nextClose(socket, 1000);

console.log('✓ workspace and terminal session persisted');
console.log('✓ duplicate output ignored and sequence gap rejected');
console.log('✓ session detail and ordered event APIs returned complete output');
console.log('Server S3 session and terminal event probe passed.');

async function pollForSessionVersion(expectedVersion) {
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${httpEndpoint}/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (response.ok) {
        const session = await response.json();
        if (session.stateVersion === expectedVersion) return session;
      } else {
        latestError = new Error(`session detail returned ${response.status}`);
      }
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw latestError ?? new Error(`session did not reach version ${expectedVersion}`);
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

function sessionEnvelope(type, seq, payload) {
  return { ...envelope(type, payload), sessionId, seq };
}

function outputPayload(value) {
  return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
}

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8');
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
