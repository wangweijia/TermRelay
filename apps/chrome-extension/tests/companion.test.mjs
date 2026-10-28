import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../companion/store.mjs';
import { Relay } from '../companion/relay.mjs';
import { createCompanion } from '../companion/server.mjs';
import { HOST, cleanPageURL, validateFeedback, promptFor } from '../companion/model.mjs';

const session = { id: randomUUID(), deviceId: randomUUID(), workspaceId: `workspace-${randomUUID()}`, status: 'running', runtimeMode: 'acp', origin: 'local' };
const input = () => ({
  id: randomUUID(), page: `https://${HOST}:8080/debug/test?token=secret#private`,
  description: 'Move the query button to the right.', steps: 'Open the market page.',
  element: { tag: 'button', role: '', text: 'Query', locator: 'button:nth-of-type(1)', ancestors: 'button, input' },
});
const binding = { sessionId: session.id, deviceId: session.deviceId, workspaceId: session.workspaceId, name: 'Test' };
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function fixture(t, deliver = async () => ({ status: 'delivered', note: 'Not AI completion.' })) {
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-preview-test-'));
  const store = new Store(join(directory, 'feedback.json'));
  await store.load();
  const calls = [];
  const app = createCompanion({
    store, relay: { deliver: async (...args) => { calls.push(args); return deliver(...args); } },
    binding, ports: [8080], reviewerToken: 'reviewer', adminToken: 'owner', proxyToken: 'proxy',
  });
  const publicURL = await listen(app.publicServer), ownerURL = await listen(app.adminServer);
  t.after(async () => { app.closeProxy(); await Promise.all([close(app.publicServer), close(app.adminServer)]); await rm(directory, { recursive: true }); });
  const request = async (path, body, owner = false, token = owner ? 'owner' : 'reviewer', extra = {}) => {
    const response = await fetch(`${owner ? ownerURL : publicURL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, store, calls, request, publicURL, ownerURL, directory };
}

test('feedback validation preserves domain/port/path, drops query and hash, rejects other origins/ports', () => {
  const body = input();
  const record = validateFeedback(body, [8080]);
  assert.equal(record.page, `https://${HOST}:8080/debug/test`);
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.throws(() => cleanPageURL('https://example.com/'), /authorized/);
  assert.throws(() => cleanPageURL(`http://${HOST}/`), /authorized/);
  assert.throws(() => validateFeedback(body, [9000]), /port/);
  assert.throws(() => validateFeedback({ ...body, description: ' ' }, [8080]), /text/);
  assert.throws(() => validateFeedback({ ...body, element: { ...body.element, text: 'x'.repeat(501) } }, [8080]), /text/);
  assert.match(promptFor(record), /untrusted observations/);
});

test('reviewer cannot dispatch; owner confirms once; ACK is not completion; reviewer accepts after owner reconciliation', async t => {
  const f = await fixture(t);
  const body = input();
  assert.equal((await f.request('/v1/feedback', body, false, 'wrong')).status, 401);
  assert.equal((await f.request('/v1/feedback', body, false, 'reviewer', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/v1/feedback', body)).status, 201);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/v1/feedback', body)).status, 200);
  assert.equal(f.store.records.length, 1);
  assert.equal((await f.request('/v1/feedback', { ...body, description: 'Different' })).status, 409);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {})).status, 403);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).body.status, 'delivered');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).status, 409);
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'verified', note: '' })).status, 409);
  assert.equal((await f.request(`/api/feedback/${body.id}/review`, { checked: true, note: 'Verified result in TermRelay.' }, true)).body.status, 'awaiting_review');
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'changes_requested', note: '' })).status, 400);
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'verified', note: '' })).body.status, 'verified');
  const listed = (await f.request('/v1/feedback')).body;
  assert.equal(listed[0].commandId, undefined);
  assert.equal(listed[0].sessionId, undefined);
  assert.equal(JSON.parse(await readFile(f.store.path, 'utf8'))[0].status, 'verified');
});

test('unknown outcome blocks subsequent delivery; restart never replays sending intent', async t => {
  const f = await fixture(t, async () => ({ status: 'unknown', note: 'Disconnected.' }));
  const first = input(), next = input();
  await f.request('/v1/feedback', first);
  await f.request('/v1/feedback', next);
  await f.request(`/api/feedback/${first.id}/deliver`, {}, true);
  assert.equal((await f.request(`/api/feedback/${next.id}/deliver`, {}, true)).status, 409);
  assert.equal(f.calls.length, 1);
  f.store.records[0].status = 'sending';
  await f.store.save();
  const recovered = new Store(f.store.path);
  await recovered.load();
  assert.equal(recovered.records[0].status, 'unknown');
});

test('developer can reconcile unknown as not executed without claiming success or allowing automatic resend', async t => {
  const f = await fixture(t, async () => ({ status: 'unknown', note: '/private/workspace/provider-detail' }));
  const body = input();
  await f.request('/v1/feedback', body);
  await f.request(`/api/feedback/${body.id}/deliver`, {}, true);
  const list = (await f.request('/v1/feedback')).body;
  assert.ok(!JSON.stringify(list).includes('/private/workspace'));
  const resolved = await f.request(`/api/feedback/${body.id}/review`, { checked: true, outcome: 'failed', note: 'Verified the command was not executed.' }, true);
  assert.equal(resolved.body.status, 'failed');
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).status, 409);
});

test('owner console rejects remote-style Host/Origin and public port cannot use admin credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state', undefined, false, 'owner')).status, 401);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.ownerURL}/api/state`, { headers: { Host: 'attacker.example', Authorization: 'Bearer owner' } },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  assert.equal((await f.request('/api/state', undefined, true, 'owner', { Origin: 'https://evil.example' })).status, 403);
});

class FakeSocket extends EventTarget {
  static mode = 'completed';
  static last;
  constructor() {
    super(); FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(raw) {
    this.envelope = JSON.parse(raw).data;
    if (FakeSocket.mode === 'timeout') return;
    if (FakeSocket.mode === 'disconnect') { this.dispatchEvent(new Event('close')); return; }
    const command = this.envelope;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'command.ack', commandId: command.commandId, deviceId: command.deviceId,
      sessionId: command.sessionId, payload: { status: FakeSocket.mode === 'ack_timeout' ? 'failed' : FakeSocket.mode, errorCode: FakeSocket.mode },
    }) })));
  }
  close() {}
}
test('relay emits actual v2 browser envelope and distinguishes final ACK, rejection, timeout and disconnect', async () => {
  for (const [mode, expected] of [['completed', 'delivered'], ['rejected', 'failed'], ['timeout', 'unknown'], ['disconnect', 'unknown'], ['ack_timeout', 'unknown']]) {
    FakeSocket.mode = mode;
    const relay = new Relay('http://127.0.0.1:3007', session.id, {
      fetchImpl: async () => new Response(JSON.stringify(session)), Socket: FakeSocket, timeout: 10,
    });
    const result = await relay.deliver({ ...validateFeedback(input(), [8080]), commandId: randomUUID() }, binding);
    assert.equal(result.status, expected);
    assert.equal(FakeSocket.last.envelope.protocolVersion, '2');
    assert.equal(FakeSocket.last.envelope.type, 'tool.turn.start');
    assert.ok(FakeSocket.last.envelope.payload.text.length < 65536);
  }
});
test('relay refuses PTY, external sessions, changed binding and public relay URL', async () => {
  assert.throws(() => new Relay('https://example.com', session.id), /trusted/);
  for (const changed of [{ runtimeMode: 'pty' }, { origin: 'external' }, { status: 'finished' }]) {
    const relay = new Relay('http://127.0.0.1:3007', session.id, { fetchImpl: async () => new Response(JSON.stringify({ ...session, ...changed })) });
    await assert.rejects(relay.session(), /ordinary ACP/);
  }
  const relay = new Relay('http://127.0.0.1:3007', session.id, { fetchImpl: async () => new Response(JSON.stringify(session)) });
  await assert.rejects(relay.deliver({}, { ...binding, workspaceId: randomUUID() }), /binding changed/);
});

test('real Node WebSocket handshake delivers the v2 envelope and correlates ACK over HTTP upgrade', async t => {
  let observed;
  const server = createServer((request, response) => {
    assert.equal(request.url, `/api/sessions/${session.id}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(session));
  });
  const upgraded = new Set();
  server.on('upgrade', (request, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    assert.equal(request.url, '/ws/web');
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      if ((buffer[0] & 15) === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      observed = JSON.parse(payload).data;
      buffer = buffer.subarray(offset + 4 + length);
      const reply = Buffer.from(JSON.stringify({
        type: 'command.ack', commandId: observed.commandId, deviceId: observed.deviceId,
        sessionId: observed.sessionId, payload: { commandId: observed.commandId, status: 'completed' },
      }));
      const header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(reply.length, 2);
      socket.write(Buffer.concat([header, reply]));
    });
  });
  const url = await listen(server);
  t.after(async () => { for (const socket of upgraded) socket.destroy(); await close(server); });
  const relay = new Relay(url, session.id);
  const commandId = randomUUID();
  const result = await relay.deliver({ ...validateFeedback(input(), [8080]), commandId }, binding);
  assert.equal(result.status, 'delivered');
  assert.equal(observed.commandId, commandId);
  assert.equal(observed.type, 'tool.turn.start');
  assert.match(observed.payload.text, /Move the query button/);
});

async function tunnel(publicURL, authority, password, data = '') {
  const url = new URL(publicURL);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let response = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Tunnel timed out.')); });
    socket.on('error', reject);
    socket.on('connect', () => {
      const auth = password ? `Proxy-Authorization: Basic ${Buffer.from(`preview:${password}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n${data}`);
    });
    socket.on('data', chunk => {
      response += chunk;
      if (response.includes('200 Connection Established') && !response.includes('LOCAL-TEST')) return;
      socket.destroy(); resolve(response);
    });
  });
}
test('CONNECT proxy authenticates, restricts ports/hostname, and forwards bytes including CONNECT head', async t => {
  const f = await fixture(t);
  assert.match(await tunnel(f.publicURL, `${HOST}:8080`), /407/);
  assert.match(await tunnel(f.publicURL, 'example.com:8080', 'proxy'), /403/);
  assert.match(await tunnel(f.publicURL, `${HOST}:9999`, 'proxy'), /403/);
  const target = createServer((request, response) => response.end('LOCAL-TEST'));
  await listen(target);
  t.after(() => close(target));
  const port = target.address().port;
  // The allowlist is explicitly configured by the developer, including arbitrary project ports.
  const app = createCompanion({
    store: f.store, relay: {}, binding, ports: [port],
    reviewerToken: 'reviewer', adminToken: 'owner', proxyToken: 'proxy',
  });
  const proxyURL = await listen(app.publicServer);
  t.after(async () => { app.closeProxy(); await close(app.publicServer); });
  const response = await tunnel(proxyURL, `${HOST}:${port}`, 'proxy', 'GET / HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n');
  assert.match(response, /200 Connection Established/);
  assert.match(response, /LOCAL-TEST/);
});

test('CLI starts responsive listeners, persists private binding credentials and releases its lock on shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-preview-cli-'));
  const relayServer = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(session));
  });
  const relayURL = await listen(relayServer);
  const unusedPort = async () => {
    const probe = createServer();
    await listen(probe);
    const port = probe.address().port;
    await close(probe);
    return port;
  };
  const port = await unusedPort(), ownerPort = await unusedPort();
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../companion/main.mjs', import.meta.url)),
    '--relay', relayURL, '--session', session.id, '--port', String(port),
    '--owner-port', String(ownerPort), '--data-dir', directory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await close(relayServer);
    await rm(directory, { recursive: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI startup timed out.')), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Use adminToken')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited during startup (${code}).`)); });
  });
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  assert.equal(credentials.workspaceId, session.workspaceId);
  const response = await fetch(`http://127.0.0.1:${port}/v1/meta`, { headers: { Authorization: `Bearer ${credentials.reviewerToken}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ports, [8080]);
  const owner = await fetch(`http://127.0.0.1:${ownerPort}/api/state`, { headers: { Authorization: `Bearer ${credentials.adminToken}` } });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).binding.sessionId, session.id);
  child.kill('SIGTERM');
  await once(child, 'exit');
  await assert.rejects(access(join(directory, 'running.lock')), { code: 'ENOENT' });
});
