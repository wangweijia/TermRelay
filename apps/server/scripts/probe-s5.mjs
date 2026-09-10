import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const clientEndpoint = process.env.SERVER_WS_URL ?? 'ws://127.0.0.1:3100/ws/client';
const browserEndpoint = process.env.SERVER_WEB_WS_URL ?? 'ws://127.0.0.1:3100/ws/web';
const deviceId = 'probe-s5-device';
const workspaceId = 'probe-s5-workspace';
const sessionId = `probe-s5-${randomUUID()}`;
const timeoutMs = 4_000;

const mac = await connect(clientEndpoint);
mac.send(wire(base('device.register', {
  name: 'S5 Command Probe Mac', appVersion: '0.1.0', platform: 'macOS', tools: ['shell'],
})));
assert((await next(mac)).data?.type === 'device.registered', 'expected device registration');
mac.send(wire(base('workspace.registered', {
  workspaceId, displayName: 'S5 Workspace', available: true, remoteStartAllowed: false,
})));
mac.send(wire({ ...base('session.started', {
  workspaceId, toolKey: 'shell', runtimeMode: 'terminal', startedAt: new Date().toISOString(),
}), sessionId, seq: 0 }));

const browser = await connect(browserEndpoint);
const commands = [
  ['terminal.input', { encoding: 'base64', data: Buffer.from('echo relay\r').toString('base64') }],
  ['terminal.resize', { columns: 120, rows: 36 }],
  ['session.interrupt', {}],
  ['session.stop', {}],
];

for (const [type, payload] of commands) {
  const commandId = randomUUID();
  browser.send(wire({ ...base(type, payload), sessionId, commandId }));
  const forwarded = await next(mac);
  assert(forwarded.data?.type === type, `expected ${type} on Mac socket`);
  assert(forwarded.data?.commandId === commandId, `expected ${type} command id`);
  mac.send(wire({
    ...base('command.ack', { commandId, status: 'completed' }), sessionId, commandId,
  }));
  const ack = await next(browser);
  assert(ack.data?.type === 'command.ack', `expected ${type} acknowledgement`);
  assert(ack.data?.payload?.status === 'completed', `expected completed ${type}`);
}

browser.close(1000, 'S5 browser probe complete');
mac.close(1000, 'S5 Mac probe complete');
console.log('✓ input, resize, interrupt, and stop routed to the target Mac');
console.log('✓ Mac command acknowledgements returned to the originating browser');
console.log('Server S5 bidirectional command relay probe passed.');

function base(type, payload) {
  return {
    type, protocolVersion: '1', messageId: randomUUID(), deviceId,
    sentAt: new Date().toISOString(), payload,
  };
}

function wire(data) { return JSON.stringify({ event: 'message', data }); }

function connect(endpoint) {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  }), 'connect');
}

function next(socket) {
  return withTimeout(new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  }), 'message');
}

function withTimeout(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
