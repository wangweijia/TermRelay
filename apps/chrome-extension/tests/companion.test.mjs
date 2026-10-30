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
import { HOST, cleanPageURL, validateFeedback, promptFor, previewConfiguration } from '../companion/model.mjs';

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
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-preview-test-'));
  const store = new Store(join(directory, 'feedback.json'));
  await store.load();
  const app = createCompanion({
    store, binding, ports: [8080], reviewerToken: 'reviewer', adminToken: 'owner', proxyToken: 'proxy', ...options,
  });
  const publicURL = await listen(app.publicServer), ownerURL = await listen(app.adminServer);
  t.after(async () => { app.closeProxy(); await Promise.all([close(app.publicServer), close(app.adminServer)]); await rm(directory, { recursive: true }); });
  let lease;
  const request = async (path, body, owner = false, token = owner ? 'owner' : 'reviewer', extra = {}) => {
    const response = await fetch(`${owner ? ownerURL : publicURL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(!owner && lease ? { 'X-TermRelay-Client-ID': lease.clientId, 'X-TermRelay-Connection-Token': lease.connectionToken } : {}), ...extra },
      ...(body ? { method: 'POST', body: JSON.stringify({ ...(path === '/v1/connect' ? { proxyToken: 'proxy' } : {}), ...body }) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  lease = (await request('/v1/connect', { clientId: randomUUID() })).body;
  const prepare = async id => (await request(`/api/feedback/${id}/deliver`, {}, true)).body;
  const result = async (id, dispatch, status = 'running', note = 'Local turn accepted, not AI completion.', revision = 1, turnId = null) =>
    request(`/api/feedback/${id}/result`, { commandId: dispatch.commandId, status, note, revision, turnId }, true);
  return { app, store, request, prepare, result, publicURL, ownerURL, lease };
}

test('feedback accepts any valid HTTPS port on the exact preview hostname and sanitizes URLs', () => {
  const body = input();
  const record = validateFeedback(body);
  assert.equal(record.page, `https://${HOST}:8080/debug/test`);
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.throws(() => cleanPageURL('https://example.com/'), /authorized/);
  assert.throws(() => cleanPageURL(`http://${HOST}/`), /authorized/);
  for (const port of [1, 443, 8080, 8101, 65535]) {
    const url = new URL(`https://${HOST}:${port}/__debug/`);
    assert.equal(validateFeedback({ ...body, page: url.href }).page, url.href);
  }
  for (const page of [`https://${HOST}:0/`, `https://${HOST}:65536/`, `https://${HOST}.evil.example:8101/`]) {
    assert.throws(() => validateFeedback({ ...body, page }), /authorized|Invalid page/);
  }
  assert.throws(() => validateFeedback({ ...body, description: ' ' }), /text/);
  assert.throws(() => validateFeedback({ ...body, element: { ...body.element, text: 'x'.repeat(501) } }), /text/);
  assert.match(promptFor(record), /untrusted observations/);
});

test('feedback API accepts an unlisted resource port but still rejects other hostnames', async t => {
  const f = await fixture(t);
  const body = { ...input(), page: `https://${HOST}:8101/__debug/` };
  assert.deepEqual((await f.request('/v1/meta')).body.ports, [8080]);
  assert.equal((await f.request('/v1/feedback', body)).status, 201);
  assert.equal(f.store.records[0].page, body.page);
  assert.equal((await f.request('/v1/feedback', { ...input(), page: 'https://other.example:8101/' })).status, 400);
});

test('configured direct LAN pages and project domains are scoped without a proxy', async t => {
  for (const url of ['http://192.168.1.20:5173/project/', 'https://project.example:8080/']) {
    const preview = { url, accessMode: 'direct' };
    const f = await fixture(t, { preview });
    assert.deepEqual((await f.request('/v1/meta')).body.preview, preview);
    assert.deepEqual((await f.request('/v1/meta')).body.previewURLs, [url]);
    assert.equal((await f.request('/v1/feedback', { ...input(), page: `${url}?token=private#secret` })).status, 201);
    assert.equal(f.store.records[0].page, url);
    assert.equal((await f.request('/v1/feedback', input())).status, 400);
    assert.equal((await f.request('/v1/feedback', { ...input(), page: url.replace(/:\d+/, ':9999') })).status, 400);
    assert.match(await tunnel(f.publicURL, `${new URL(url).hostname}:8080`, f.lease.proxyToken), /403/);
  }
});

test('configured proxy accepts only the project hostname and keeps cross-port support', async t => {
  const preview = { url: 'https://another-project.test:8080/', accessMode: 'proxy' };
  const f = await fixture(t, { preview });
  assert.equal((await f.request('/v1/feedback', { ...input(), page: 'https://another-project.test:8101/page' })).status, 201);
  assert.equal((await f.request('/v1/feedback', input())).status, 400);
  assert.match(await tunnel(f.publicURL, `${HOST}:8080`, f.lease.proxyToken), /403/);
});

test('project configuration rejects unsafe URLs and invalid access modes', () => {
  for (const url of ['file:///tmp/test', 'https://user:secret@example.com/', 'http://localhost:5173/',
    'http://127.0.0.1/', 'https://example.com:0/', 'https://example.com/?token=secret', 'https://example.com/#secret']) {
    assert.throws(() => previewConfiguration({ url, accessMode: 'direct' }));
  }
  assert.throws(() => previewConfiguration({ url: 'https://example.com/', accessMode: 'invalid' }));
});

test('configured HTTP proxy preserves Host and path but strips proxy credentials', async t => {
  const target = createServer((request, response) => response.end(JSON.stringify({ host: request.headers.host,
    path: request.url, proxyAuthorization: request.headers['proxy-authorization'] })));
  await listen(target);
  t.after(() => close(target));
  const port = target.address().port;
  const f = await fixture(t, { preview: { url: `http://project.test:${port}/`, accessMode: 'proxy' } });
  const request = (host, password) => new Promise((resolve, reject) => {
    const response = httpRequest(f.publicURL, { path: `http://${host}:${port}/page?value=1`,
      headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`preview:${password}`).toString('base64')}` } }, result => {
      let body = ''; result.on('data', chunk => body += chunk); result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    response.on('error', reject); response.end();
  });
  assert.deepEqual(JSON.parse((await request('project.test', f.lease.proxyToken)).body), { host: `project.test:${port}`, path: '/page?value=1' });
  assert.equal((await request('other.test', f.lease.proxyToken)).status, 403);
  assert.equal((await request('project.test', 'wrong')).status, 407);
});

test('configured HTTP proxy forwards WebSocket upgrades without proxy credentials', async t => {
  let observed;
  const target = createServer();
  target.on('upgrade', (request, socket) => {
    observed = { host: request.headers.host, path: request.url, proxyAuthorization: request.headers['proxy-authorization'] };
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nSYNTHETIC-FRAME');
  });
  await listen(target);
  t.after(() => close(target));
  const port = target.address().port;
  const f = await fixture(t, { preview: { url: `http://project.test:${port}/`, accessMode: 'proxy' } });
  const proxy = new URL(f.publicURL);
  const response = await new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname);
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade timed out.')));
    socket.on('error', reject);
    socket.on('data', chunk => data += chunk);
    socket.on('end', () => resolve(data));
    socket.on('connect', () => socket.write(`GET http://project.test:${port}/hmr HTTP/1.1\r\nHost: project.test:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Basic ${Buffer.from(`preview:${f.lease.proxyToken}`).toString('base64')}\r\n\r\n`));
  });
  assert.match(response, /101 Switching Protocols/);
  assert.match(response, /SYNTHETIC-FRAME/);
  assert.deepEqual(observed, { host: `project.test:${port}`, path: '/hmr', proxyAuthorization: undefined });
});

test('local-only App dispatch persists intent before execution and completes the reviewer loop', async t => {
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
  assert.equal((await f.result(body.id, dispatch)).body.status, 'running');
  assert.equal((await f.result(body.id, dispatch)).status, 200);
  assert.equal((await f.request(`/api/feedback/${body.id}/deliver`, {}, true)).status, 409);
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'verified', note: '' })).status, 409);
  assert.equal((await f.result(body.id, dispatch, 'awaiting_review', 'This turn completed; verify the page.', 2)).body.status, 'awaiting_review');
  assert.equal((await f.result(body.id, dispatch)).status, 409);
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'changes_requested', note: '' })).status, 400);
  assert.equal((await f.request(`/v1/feedback/${body.id}/verify`, { status: 'verified', note: '' })).body.status, 'verified');
  assert.equal((await f.result(body.id, dispatch, 'awaiting_review', 'This turn completed; verify the page.', 2)).body.status, 'verified');
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

test('one plugin instance owns the entire App connection; same-profile tabs share it and disconnect releases it', async t => {
  const f = await fixture(t);
  const other = randomUUID();
  assert.equal((await f.request('/v1/connect', { clientId: [other] })).status, 400);
  assert.equal((await f.request('/v1/connect', { clientId: other, proxyToken: 'wrong' })).status, 401);
  assert.equal((await f.request('/v1/connect', { clientId: other })).status, 409);
  const same = await f.request('/v1/connect', { clientId: f.lease.clientId });
  assert.equal(same.body.connectionToken, f.lease.connectionToken);
  assert.equal((await f.request('/v1/meta', undefined, false, 'reviewer', { 'X-TermRelay-Client-ID': other })).status, 409);
  assert.equal((await f.request('/v1/feedback', input(), false, 'reviewer', { 'X-TermRelay-Connection-Token': 'wrong' })).status, 409);
  assert.match(await tunnel(f.publicURL, `${HOST}:8080`, 'proxy'), /407/);
  assert.equal((await f.request('/api/state', undefined, true)).body.connection.clientId, f.lease.clientId);
  assert.equal((await f.request('/v1/disconnect', {})).status, 200);
  assert.equal((await f.request('/v1/meta')).status, 409);
  const replacement = await f.request('/v1/connect', { clientId: other });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.proxyToken, f.lease.proxyToken);
  assert.equal((await f.request('/v1/feedback')).status, 409);
});

test('heartbeats renew the lease, expiration releases it and old tokens cannot operate or submit', async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time });
  time += 80_000;
  assert.equal((await f.request('/v1/meta')).status, 200);
  time += 80_000;
  assert.equal((await f.request('/v1/connect', { clientId: randomUUID() })).status, 409);
  time += 10_001;
  const next = await f.request('/v1/connect', { clientId: randomUUID() });
  assert.equal(next.status, 200);
  assert.equal((await f.request('/v1/feedback', input())).status, 409);
  assert.match(await tunnel(f.publicURL, `${HOST}:8080`, f.lease.proxyToken), /407/);
});

test('disconnect closes established proxy tunnels, not only new authentication attempts', async t => {
  const f = await fixture(t);
  const target = createServer();
  await listen(target);
  t.after(() => close(target));
  const proxy = new URL(f.publicURL);
  const client = connect(Number(proxy.port), proxy.hostname);
  t.after(() => client.destroy());
  await once(client, 'connect');
  const authenticated = once(client, 'data');
  const password = Buffer.from(`preview:${f.lease.proxyToken}`).toString('base64');
  client.write(`CONNECT ${HOST}:${target.address().port} HTTP/1.1\r\nHost: ${HOST}\r\nProxy-Authorization: Basic ${password}\r\n\r\n`);
  assert.match(String((await authenticated)[0]), /200 Connection Established/);
  const closed = once(client, 'close');
  assert.equal((await f.request('/v1/disconnect', {})).status, 200);
  await closed;
});

test('restart marks every in-flight execution state unknown without replaying or losing the command/turn IDs', async t => {
  const f = await fixture(t);
  const body = input();
  await f.request('/v1/feedback', body);
  const dispatch = await f.prepare(body.id);
  for (const status of ['sending', 'running', 'awaiting_approval', 'awaiting_input']) {
    Object.assign(f.store.records[0], { status, turnId: 'provider-turn' });
    await f.store.save();
    const recovered = new Store(f.store.path);
    await recovered.load();
    assert.equal(recovered.records[0].status, 'unknown');
    assert.equal(recovered.records[0].commandId, dispatch.commandId);
    assert.equal(recovered.records[0].turnId, 'provider-turn');
  }
});

test('execution progress is command/turn correlated, revisioned and cannot overwrite a final result', async t => {
  const f = await fixture(t);
  const body = input();
  await f.request('/v1/feedback', body);
  const dispatch = await f.prepare(body.id), turn = randomUUID();
  assert.equal((await f.result(body.id, dispatch, 'running', '', 1, turn)).status, 200);
  assert.equal((await f.result(body.id, dispatch, 'awaiting_approval', '', 2, turn)).status, 200);
  assert.equal((await f.request('/v1/feedback')).body[0].status, 'awaiting_approval');
  assert.equal((await f.result(body.id, dispatch, 'running', '', 1, turn)).status, 409);
  assert.equal((await f.result(body.id, dispatch, 'running', '', 3, 'another-turn')).status, 409);
  assert.equal((await f.result(body.id, dispatch, 'awaiting_input', '', 3, turn)).status, 200);
  assert.equal((await f.result(body.id, dispatch, 'running', '', 4, turn)).status, 200);
  assert.equal((await f.result(body.id, dispatch, 'awaiting_review', 'Turn completed.', 5, turn)).status, 200);
  assert.equal((await f.result(body.id, dispatch, 'awaiting_review', 'Turn completed.', 5, turn)).status, 200);
  assert.equal((await f.result(body.id, dispatch, 'running', '', 6, turn)).status, 409);
  assert.equal((await f.request('/v1/feedback')).body[0].note, 'Turn completed.');
});

test('retrying a progress update after a save failure persists it before acknowledging success', async t => {
  const f = await fixture(t);
  const body = input();
  await f.request('/v1/feedback', body);
  const dispatch = await f.prepare(body.id);
  const save = f.store.save.bind(f.store);
  let fail = true;
  f.store.save = async () => {
    if (fail) { fail = false; throw new Error('Synthetic persistence failure.'); }
    await save();
  };
  assert.equal((await f.result(body.id, dispatch)).status, 500);
  assert.equal(JSON.parse(await readFile(f.store.path, 'utf8'))[0].status, 'sending');
  assert.equal((await f.result(body.id, dispatch)).status, 200);
  assert.equal(JSON.parse(await readFile(f.store.path, 'utf8'))[0].status, 'running');
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
test('CONNECT proxy authenticates and rejects other hostnames and invalid ports', async t => {
  const f = await fixture(t);
  assert.match(await tunnel(f.publicURL, `${HOST}:8080`), /407/);
  for (const authority of [
    'example.com:8080', `${HOST}.evil.example:8101`, '127.0.0.1:8101',
    `${HOST}:0`, `${HOST}:65536`, `${HOST}:99999`, `${HOST}:abc`, `${HOST}:8080:8101`, HOST,
  ]) {
    assert.match(await tunnel(f.publicURL, authority, f.lease.proxyToken), /403/, authority);
  }
});

test('one proxy forwards page and CSS/JS requests to multiple original ports without listing them', async t => {
  const f = await fixture(t);
  const pageServer = createServer((request, response) => response.end(`LOCAL-TEST page ${request.url}`));
  const assetServer = createServer((request, response) => response.end(`LOCAL-TEST asset ${request.url}`));
  await Promise.all([listen(pageServer), listen(assetServer)]);
  t.after(() => Promise.all([close(pageServer), close(assetServer)]));
  const pagePort = pageServer.address().port, assetPort = assetServer.address().port;
  assert.ok(![8080].includes(pagePort) && ![8080].includes(assetPort));
  for (const [port, path, expected] of [
    [pagePort, '/debug/market-tracker/nev2', 'page'],
    [assetPort, '/__debug/index.css', 'asset'],
    [assetPort, '/__debug/index.js', 'asset'],
  ]) {
    const response = await tunnel(f.publicURL, `${HOST}:${port}`, f.lease.proxyToken,
      `GET ${path} HTTP/1.1\r\nHost: ${HOST}:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(response, /200 Connection Established/);
    assert.ok(response.includes(`LOCAL-TEST ${expected} ${path}`), response);
  }
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
  const connected = await fetch(`http://127.0.0.1:${port}/v1/connect`, {
    method: 'POST', headers: { Authorization: `Bearer ${credentials.reviewerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: randomUUID(), proxyToken: credentials.proxyToken }),
  });
  const lease = await connected.json();
  const response = await fetch(`http://127.0.0.1:${port}/v1/meta`, { headers: { Authorization: `Bearer ${credentials.reviewerToken}`,
    'X-TermRelay-Client-ID': lease.clientId, 'X-TermRelay-Connection-Token': lease.connectionToken } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ports, [8080]);
  const owner = await fetch(`http://127.0.0.1:${ownerPort}/api/state`, { headers: { Authorization: `Bearer ${credentials.adminToken}` } });
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).binding.sessionId, binding.sessionId);
  child.kill('SIGTERM');
  await once(child, 'exit');
  await assert.rejects(access(join(directory, 'running.lock')), { code: 'ENOENT' });
});
