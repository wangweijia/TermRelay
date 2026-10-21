import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { ConfigStore } from '../src/config.js';
import { AgentService } from '../src/service.js';
import { CodexRuntime } from '../src/codex.js';
import { JsonLineClient } from '../src/rpc.js';
import { RelayConnection } from '../src/transport.js';
import { record } from '../src/util.js';
import { createServer } from 'node:http';
import { serverPacket } from './fixtures/relay.js';

async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 7000;
  while (!condition()) { if (Date.now() > end) throw new Error('Integration condition timed out'); await delay(10); }
}

test('headless Agent -> real WebSocket -> synthetic Codex -> ordered events/ACK -> shutdown', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'termrelay-ts-service-')));
  t.after(() => rmSync(directory, { recursive: true }));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const store = new ConfigStore(join(directory, 'agent.json'));
  const config = store.configure(`ws://127.0.0.1:${address.port}/ws/client`, 'Linux test');
  const workspaceId = randomUUID();
  config.workspaces = [{ id: workspaceId, name: 'Project', path: directory }];
  config.sessions = [{ id: randomUUID(), workspaceId, provider: 'codex' }];
  config.tools.codex = process.execPath; store.save(config);
  const commandId = randomUUID(), packets: Record<string, unknown>[] = [], acknowledgments: string[] = [];
  let completed = false, auth = '';
  server.on('connection', (socket, request) => {
    auth = request.headers.authorization ?? '';
    const send = (type: string, payload: unknown, sessionId?: string, id?: string) => socket.send(JSON.stringify({
      event: 'message', data: { type, payload, deviceId: config.deviceId, protocolVersion: '2', messageId: randomUUID(),
        sentAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...(id ? { commandId: id } : {}) },
    }));
    let seq = 0;
    socket.on('message', raw => {
      const value = record(record(JSON.parse(raw.toString())).data), payload = record(value.payload);
      packets.push(value);
      if (value.type === 'device.register') send('device.registered', { heartbeatIntervalMs: 15000 });
      else if (value.type === 'session.started') {
        send('session.synced', { lastAcceptedSeq: 0, autoApproveEnabled: false }, String(value.sessionId));
        send('tool.turn.start', { text: 'synthetic prompt' }, String(value.sessionId), commandId);
      } else if (value.type === 'tool.event') {
        seq = Number(value.seq);
        if (payload.kind === 'turn.completed') completed = true;
      } else if (value.type === 'session.sync') send('session.synced', { lastAcceptedSeq: seq }, String(value.sessionId));
      else if (value.type === 'command.ack') acknowledgments.push(String(payload.status));
    });
  });
  const service = new AgentService(store, {
    log: () => undefined,
    codex: (_executable, cwd, emit) => new CodexRuntime('synthetic', cwd, emit,
      (_argv, dir, receive, fail) => new JsonLineClient([process.execPath, join(__dirname, 'fixtures/fake-codex.js')], dir, receive, fail)),
  });
  const running = service.run();
  try {
    await until(() => completed && service.protocol.unacknowledgedBytes === 0);
    assert.equal(service.state, 'online');
    assert.deepEqual(acknowledgments, ['accepted', 'completed']);
    assert.equal(auth, '');
    assert.equal(JSON.stringify(packets).includes(directory), false);
    assert.equal(packets.some(p => p.type === 'terminal.output'), false);
  } finally { service.stop(); assert.equal(await running, 0); }
  const status = record(JSON.parse(readFileSync(store.statusPath, 'utf8')));
  assert.equal(status.state, 'stopped');
  assert.equal(JSON.stringify(status).includes('synthetic prompt'), false);
});

test('transport uses Authorization header instead of URL credentials', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let received = '', connected = false;
  server.on('connection', (_socket, request) => { received = request.headers.authorization ?? ''; });
  const connection = new RelayConnection(`ws://127.0.0.1:${address.port}/ws/client`, 'synthetic-token', event => {
    if (event.kind === 'connected') connected = true;
  });

  connection.start();
  try { await until(() => connected && !!received); assert.equal(received, 'Bearer synthetic-token'); }
  finally { connection.close(); }
});

test('zero-profile service remotely creates Codex and real PTY once, preserves interaction and isolates startup failures', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'termrelay-ts-remote-')));
  t.after(() => rmSync(directory, { recursive: true }));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const store = new ConfigStore(join(directory, 'agent.json'));
  const config = store.configure(`ws://127.0.0.1:${address.port}/ws/client`, 'Remote Linux');
  const workspaceId = randomUUID();
  config.workspaces = [{ id: workspaceId, name: 'Remote project', path: directory, remoteStartAllowed: true }];
  config.tools.codex = process.execPath; store.save(config);
  const packets: Record<string, unknown>[] = [];
  let socket: import('ws').WebSocket | undefined;
  server.on('connection', client => {
    socket = client;
    const seq = new Map<string, number>();
    client.on('message', raw => {
      const message = record(record(JSON.parse(raw.toString())).data);
      packets.push(message);
      const id = String(message.sessionId);
      if (message.type === 'device.register') client.send(JSON.stringify(serverPacket(config.deviceId, 'device.registered', { heartbeatIntervalMs: 15000 })));
      else if (message.type === 'session.started') {
        seq.set(id, 0);
        client.send(JSON.stringify(serverPacket(config.deviceId, 'session.synced', { lastAcceptedSeq: 0, autoApproveEnabled: false }, id)));
      } else if (message.type === 'tool.event' || message.type === 'terminal.output') seq.set(id, Number(message.seq));
      else if (message.type === 'session.sync') client.send(JSON.stringify(serverPacket(config.deviceId, 'session.synced', { lastAcceptedSeq: seq.get(id) ?? 0 }, id)));
    });
  });
  let launches = 0, closes = 0, failNext = false;
  const logs: string[] = [];
  const service = new AgentService(store, {
    log: message => logs.push(message),
    codex: (_executable, cwd, emit) => {
      launches++;
      if (failNext) return {
        start: async () => { throw new Error(`Synthetic failure containing private path ${directory}`); },
        publishConfiguration: () => undefined, command: async () => undefined, setAutoApprove: async () => undefined,
        close: async () => { closes++; },
      };
      return new CodexRuntime('synthetic', cwd, emit, (_argv, dir, receive, fail) =>
        new JsonLineClient([process.execPath, join(__dirname, 'fixtures/fake-codex.js')], dir, receive, fail));
    },
  });
  const running = service.run();
  const send = (kind: string, payload: unknown, id: string, commandId = id) =>
    socket!.send(JSON.stringify(serverPacket(config.deviceId, kind, payload, id, commandId)));
  const ack = (id: string, status: string) => packets.some(p => p.type === 'command.ack' && p.commandId === id && record(p.payload).status === status);
  try {
    await until(() => service.state === 'online' && packets.some(p => p.type === 'workspace.registered'));
    assert.equal(service.protocol.sessions.size, 0);
    const catalog = record(packets.find(p => p.type === 'workspace.registered')!.payload);
    assert.equal(catalog.remoteStartAllowed, true);
    const acp = randomUUID();
    const payload = { workspaceId, toolKey: 'codex', runtimeMode: 'acp', displayName: 'Web Codex' };
    send('session.start', payload, acp); send('session.start', payload, acp);
    await until(() => ack(acp, 'completed'));
    assert.equal(launches, 1);
    assert.equal(service.protocol.sessions.get(acp)?.started.displayName, 'Web Codex');
    const turnId = randomUUID();
    send('tool.turn.start', { text: 'remote prompt' }, acp, turnId);
    await until(() => packets.some(p => p.sessionId === acp && p.type === 'tool.event' && record(p.payload).kind === 'turn.completed'));
    assert.equal(ack(turnId, 'completed'), true);
    const pty = randomUUID();
    send('session.start', { workspaceId, toolKey: 'shell', runtimeMode: 'pty', rows: 32, columns: 100 }, pty);
    await until(() => ack(pty, 'completed'));
    send('terminal.input', { encoding: 'base64', data: Buffer.from("printf 'REMOTE-%s-中文\\n' PTY\n").toString('base64') }, pty, randomUUID());
    await until(() => packets.some(p => p.type === 'terminal.output' && p.sessionId === pty
      && Buffer.from(String(record(p.payload).data), 'base64').toString('utf8').includes('REMOTE-PTY-中文')));
    failNext = true;
    const failed = randomUUID();
    send('session.start', payload, failed);
    await until(() => ack(failed, 'failed'));
    send('session.start', payload, failed);
    await delay(30);
    assert.equal(launches, 2);
    assert.equal(closes, 1);
    assert.equal(service.state, 'online');
    assert.equal(service.protocol.sessions.has(failed), false);
    assert.equal(service.protocol.sessions.get(acp)?.ended, undefined);
    assert.equal(service.protocol.sessions.get(pty)?.ended, undefined);
    assert.equal(JSON.stringify(packets).includes(directory), false);
    assert.equal(logs.some(log => log.includes('Synthetic failure')), true);
    const revoked = store.load(); revoked.workspaces[0]!.remoteStartAllowed = false; store.save(revoked);
    const blocked = randomUUID();
    send('session.start', payload, blocked);
    await until(() => ack(blocked, 'failed'));
    assert.equal(launches, 2);
  } finally { service.stop(); assert.equal(await running, 0); }
});

test('authorization failures stop retries without exposing handshake bodies', async t => {
    const server = createServer((_request, response) => {
      response.writeHead(401); response.end('synthetic-sensitive-body');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const errors: string[] = [];
    const connection = new RelayConnection(`ws://127.0.0.1:${address.port}/ws/client`, 'synthetic-token', event => {
      if (event.kind === 'fatal') errors.push(event.error.message);
    });
    connection.start();
    try {
      await until(() => errors.length > 0);
      assert.equal(errors.length, 1); assert.equal(errors.join('').includes('synthetic-sensitive-body'), false);
    } finally { connection.close(); }
});
