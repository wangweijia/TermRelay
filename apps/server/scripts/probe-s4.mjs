import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const clientEndpoint =
  process.env.SERVER_WS_URL ?? 'ws://127.0.0.1:3100/ws/client';
const browserEndpoint =
  process.env.SERVER_WEB_WS_URL ?? 'ws://127.0.0.1:3100/ws/web';
const deviceId = 'probe-s4-device';
const workspaceId = 'probe-s4-workspace';
const sessionId = `probe-s4-${randomUUID()}`;
const timeoutMs = 4_000;

const client = await connect(clientEndpoint);
client.send(
  wireMessage(
    clientEnvelope('device.register', {
      name: 'S4 Realtime Probe Mac',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: ['shell'],
    }),
  ),
);
const registration = await nextMessage(client);
assert(registration.data?.type === 'device.registered', 'expected device.registered');

client.send(
  wireMessage(
    clientEnvelope('workspace.registered', {
      workspaceId,
      displayName: 'S4 Probe Workspace',
      available: true,
      remoteStartAllowed: false,
    }),
  ),
);
client.send(
  wireMessage(
    sessionEnvelope('session.started', 0, {
      workspaceId,
      toolKey: 'shell',
      runtimeMode: 'terminal',
      startedAt: new Date().toISOString(),
    }),
  ),
);
client.send(
  wireMessage(
    sessionEnvelope('terminal.output', 1, outputPayload('history line\n')),
  ),
);

const browser = await connect(browserEndpoint);
browser.send(
  wireMessage(
    browserEnvelope('session.subscribe', {
      afterSeq: -1,
    }),
  ),
);
const snapshot = await nextMessage(browser);
assert(snapshot.data?.type === 'session.subscribed', 'expected session.subscribed');
assert(snapshot.data?.payload?.session?.id === sessionId, 'expected session snapshot');
assert(
  snapshot.data?.payload?.events?.map((event) => event.seq).join(',') === '0,1',
  'expected ordered history events',
);

const livePayload = outputPayload('live line 🚀\n');
client.send(
  wireMessage(sessionEnvelope('terminal.output', 2, livePayload)),
);
const live = await nextMessage(browser);
assert(live.data?.type === 'terminal.output', 'expected live terminal.output');
assert(live.data?.seq === 2, 'expected live sequence 2');
assert(live.data?.payload?.data === livePayload.data, 'expected live payload');

client.send(
  wireMessage(sessionEnvelope('terminal.output', 2, livePayload)),
);
await expectNoMessage(browser, 200, 'duplicate event should not be broadcast');

browser.send(wireMessage(browserEnvelope('session.unsubscribe', {})));
const unsubscribed = await nextMessage(browser);
assert(unsubscribed.data?.type === 'session.unsubscribed', 'expected unsubscribe ack');
client.send(
  wireMessage(
    sessionEnvelope('terminal.output', 3, outputPayload('after unsubscribe\n')),
  ),
);
await expectNoMessage(browser, 200, 'unsubscribed browser received an event');

const browserClosed = nextClose(browser, 1000);
const clientClosed = nextClose(client, 1000);
browser.close(1000, 'S4 browser probe complete');
client.close(1000, 'S4 client probe complete');
await Promise.all([browserClosed, clientClosed]);

console.log('✓ browser subscription received an ordered history snapshot');
console.log('✓ terminal output streamed live without duplicate delivery');
console.log('✓ unsubscribe stopped subsequent terminal events');
console.log('Server S4 read-only terminal relay probe passed.');

function clientEnvelope(type, payload) {
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
  return { ...clientEnvelope(type, payload), sessionId, seq };
}

function browserEnvelope(type, payload) {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId,
    sessionId,
    sentAt: new Date().toISOString(),
    payload,
  };
}

function outputPayload(value) {
  return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
}

function wireMessage(data) {
  return JSON.stringify({ event: 'message', data });
}

function connect(endpoint) {
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

function expectNoMessage(socket, duration, message) {
  return new Promise((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, duration);
    socket.once('message', onMessage);
  });
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
