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
import { randomUUID } from 'node:crypto';
import { Store } from '../companion/store.mjs';
import { createCompanion } from '../companion/server.mjs';
import { HOST, cleanPageURL, validateFeedback, promptFor } from '../companion/model.mjs';

const binding = { sessionId: randomUUID(), deviceId: randomUUID(), workspaceId: `workspace-${randomUUID()}`, name: 'Local test' };
const input = () => ({
  id: randomUUID(), page: `https://${HOST}:8080/debug/test?token=secret#private`,
  description: 'Move the query button to the right.', steps: 'Open the market page.',
  element: { tag: 'button', role: '', text: 'Query', locator: 'button:nth-of-type(1)', ancestors: 'button, input' },
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-preview-test-'));
  const store = new Store(join(directory, 'feedback.json'));
  await store.load();
  const app = createCompanion({
    store, binding, ports: [8080], reviewerToken: 'reviewer', adminToken: 'owner', proxyToken: 'proxy',
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
  const prepare = async id => (await request(`/api/feedback/${id}/deliver`, {}, true)).body;
  const result = async (id, dispatch, status = 'delivered', note = 'Local turn accepted, not AI completion.') =>
    request(`/api/feedback/${id}/result`, { commandId: dispatch.commandId, status, note }, true);
  return { app, store, request, prepare, result, publicURL, ownerURL };
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

test('local-only owner dispatch persists intent before App execution and completes the reviewer loop', async t => {
  const f = await fixture(t);
  const body = input();
  assert.equal((await f.request('/v1/feedback', body, false, 'wrong')).status, 401);
  assert.equal((await f.request('/v1/feedback', body, false, 'reviewer', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/v1/feedback', body)).status, 201);
  assert.equal((await f.request('/v1/feedback', body)).status, 200);
  assert.equal(f.store.records.length, 1);
  assert.equal((await f.request('/v1/feedback', { ...body, description: 'Different' })).status, 409);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {})).status, 403);
  const dispatch = await f.prepare(body.id);
  assert.deepEqual(dispatch.binding, binding);
  assert.match(dispatch.text, /Move the query button/);
  assert.match(dispatch.text, /untrusted observations/);
  const saved = JSON.parse(await readFile(f.store.path, 'utf8'))[0];
  assert.equal(saved.status, 'sending');
  assert.equal(saved.commandId, dispatch.commandId);
  assert.equal((await f.request(`/api/feedback/${body.id}/result`, { commandId: dispatch.commandId, status: 'delivered', note: '' })).status, 403);
  assert.equal((await f.result(body.id, { commandId: randomUUID() })).status, 409);
  assert.equal((await f.result(body.id, dispatch, 'verified')).status, 409);
  assert.equal((await f.result(body.id, dispatch)).body.status, 'delivered');
  assert.equal((await f.result(body.id, dispatch)).status, 409);
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

test('sending and unknown block further dispatch; restart never replays execution', async t => {
  const f = await fixture(t);
  const first = input(), next = input();
  await f.request('/v1/feedback', first);
  await f.request('/v1/feedback', next);
  const attempts = await Promise.all([
    f.request(`/api/feedback/${first.id}/deliver`, {}, true),
    f.request(`/api/feedback/${next.id}/deliver`, {}, true),
  ]);
  assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
  const recovered = new Store(f.store.path);
  await recovered.load();
  assert.equal(recovered.records.filter(record => record.status === 'unknown').length, 1);
  assert.equal(recovered.records.filter(record => record.status === 'pending').length, 1);
  const dispatch = attempts.find(item => item.status === 200).body;
  const record = f.store.records.find(item => item.commandId === dispatch.commandId);
  assert.equal((await f.result(record.id, dispatch, 'unknown', 'Local runtime outcome is uncertain.')).body.status, 'unknown');
  assert.equal((await f.request(`/api/feedback/${next.id}/deliver`, {}, true)).status, 409);
});

test('developer can reconcile a lost dispatch response without restarting or claiming success', async t => {
  const f = await fixture(t);
  const body = input();
  await f.request('/v1/feedback', body);
  const dispatch = await f.prepare(body.id);
  assert.equal((await f.request(`/api/feedback/${body.id}/review`, { checked: true, outcome: 'failed', note: 'Verified no local turn is running.' }, true)).body.status, 'failed');
  assert.equal((await f.result(body.id, dispatch)).status, 409);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).status, 409);
});

test('local runtime failure details stay private, and failed execution is never automatically resent', async t => {
  const f = await fixture(t);
  for (const status of ['failed', 'unknown']) {
    const body = input();
    await f.request('/v1/feedback', body);
    const dispatch = await f.prepare(body.id);
    assert.equal((await f.result(body.id, dispatch, status, '/private/workspace/provider-detail')).body.status, status);
    assert.ok(!JSON.stringify((await f.request('/v1/feedback')).body).includes('/private/workspace'));
    if (status === 'unknown') {
      await f.request(`/api/feedback/${body.id}/review`, { checked: true, outcome: 'failed', note: 'Verified execution ended.' }, true);
    }
    assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).status, 409);
  }
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
  const app = createCompanion({
    store: f.store, binding, ports: [port],
    reviewerToken: 'reviewer', adminToken: 'owner', proxyToken: 'proxy',
  });
  const proxyURL = await listen(app.publicServer);
  t.after(async () => { app.closeProxy(); await close(app.publicServer); });
  const response = await tunnel(proxyURL, `${HOST}:${port}`, 'proxy', 'GET / HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n');
  assert.match(response, /200 Connection Established/);
  assert.match(response, /LOCAL-TEST/);
});

test('CLI starts without any Server, persists local binding and releases its lock on shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-preview-cli-'));
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
    '--session', binding.sessionId, '--device', binding.deviceId, '--workspace', binding.workspaceId,
    '--port', String(port), '--owner-port', String(ownerPort), '--data-dir', directory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(directory, { recursive: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI startup timed out.')), 5000);
    let output = '', errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Use adminToken')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited during startup (${code}): ${errors}`)); });
  });
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  assert.equal(credentials.workspaceId, binding.workspaceId);
  assert.equal(credentials.relay, undefined);
  const response = await fetch(`http://127.0.0.1:${port}/v1/meta`, { headers: { Authorization: `Bearer ${credentials.reviewerToken}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ports, [8080]);
  const owner = await fetch(`http://127.0.0.1:${ownerPort}/api/state`, { headers: { Authorization: `Bearer ${credentials.adminToken}` } });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).binding.sessionId, binding.sessionId);
  child.kill('SIGTERM');
  await once(child, 'exit');
  await assert.rejects(access(join(directory, 'running.lock')), { code: 'ENOENT' });
});
