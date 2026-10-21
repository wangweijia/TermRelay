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

test('transport uses Authorization header and rejects unauthorized without leaking response body', async t => {
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
