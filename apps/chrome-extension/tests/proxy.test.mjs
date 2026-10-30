import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const config = { companionURL: 'http://192.168.1.20:18420', reviewerToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64) };
const HOST = 'page-gateway-local.nioint.com';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(initial = {}, controller = 'available') {
  const storage = structuredClone({ config, ...initial });
  const handlers = {}, calls = { set: [], clear: [], fetch: [], errors: [] };
  let ownProxy;
  const foreignProxy = { mode: 'pac_script', pacScript: { data: 'function FindProxyForURL() { return "PROXY company.example:8080"; }' } };
  const chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in storage).map(key => [key, structuredClone(storage[key])]));
      },
      async set(values) { Object.assign(storage, structuredClone(values)); },
      async remove(key) { delete storage[key]; },
    } },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: listener => { handlers.message = listener; } },
    },
    proxy: {
      settings: {
        async get() {
          return {
            levelOfControl: controller === 'other' ? 'controlled_by_other_extensions'
              : controller === 'policy' ? 'not_controllable' : ownProxy ? 'controlled_by_this_extension' : 'controllable_by_this_extension',
            value: controller === 'other' || controller === 'policy' ? structuredClone(foreignProxy) : ownProxy || { mode: 'system' },
          };
        },
        async set(value) { calls.set.push(value); ownProxy = value.value; },
        async clear(value) { calls.clear.push(value); ownProxy = undefined; },
      },
      onProxyError: { addListener: listener => { handlers.proxyError = listener; } },
    },
    alarms: { async create() {}, async clear() {}, onAlarm: { addListener() {} } },
    webRequest: { onAuthRequired: { addListener: listener => { handlers.auth = listener; } } },
    action: { onClicked: { addListener() {} } },
  };
  runInNewContext(source, {
    chrome, URL, crypto: { randomUUID }, AbortSignal,
    console: { error: (...args) => calls.errors.push(args) },
    fetch: async (url, options) => {
      calls.fetch.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/v1/connect')
        ? { clientId: storage.clientId, connectionToken: 'c'.repeat(64), proxyToken: 'd'.repeat(64) }
        : url.endsWith('/v1/meta') ? { ports: [8080] } : {} };
    },
  });
  const send = message => new Promise(resolve => {
    handlers.message(message, { url: chrome.runtime.getURL('options.html') }, resolve);
  });
  const auth = details => new Promise(resolve => handlers.auth(details, resolve));
  await send({ type: 'settings.get' });
  return {
    storage, calls, send, auth, foreignProxy, chrome,
    control: value => { controller = value; },
    async proxyError(error = { error: 'net::ERR_PROXY_CONNECTION_FAILED', details: 'Do not log raw details.' }) {
      handlers.proxyError(error);
      await tick();
    },
  };
}

test('existing installs default to built-in PAC, and stopping clears only our own override', async () => {
  const f = await fixture();
  assert.equal((await f.send({ type: 'settings.get' })).data.proxyMode, 'builtin');
  assert.equal((await f.send({ type: 'proxy.set', enabled: true })).ok, true);
  assert.equal(f.calls.set.length, 1);
  const pac = f.calls.set[0].value.pacScript.data;
  assert.equal(runInNewContext(`${pac}; FindProxyForURL("https://${HOST}:8101/", "${HOST}")`), 'PROXY 192.168.1.20:18420');
  assert.equal(runInNewContext(`${pac}; FindProxyForURL("https://example.com/", "example.com")`), 'DIRECT');
  assert.equal(f.storage.proxyEnabled, true);
  f.control('other');
  const before = await f.chrome.proxy.settings.get();
  assert.equal((await f.send({ type: 'proxy.set', enabled: false })).ok, true);
  assert.deepEqual(await f.chrome.proxy.settings.get(), before);
  assert.equal(f.storage.proxyEnabled, false);
});

test('built-in mode refuses other extensions and administrator policy without changing proxy settings', async () => {
  for (const controller of ['other', 'policy']) {
    const f = await fixture({}, controller);
    const result = await f.send({ type: 'proxy.set', enabled: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /未修改设置/);
    assert.equal(f.calls.set.length, 0);
    assert.equal(f.calls.clear.length, 0);
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('switching to ZeroOmega releases our PAC, preserves the App connection, and never writes an external PAC', async () => {
  const f = await fixture();
  await f.send({ type: 'proxy.set', enabled: true });
  const connection = structuredClone(f.storage.connection);
  assert.equal((await f.send({ type: 'proxy.mode', mode: 'zeroomega' })).ok, true);
  assert.equal(f.storage.proxyMode, 'zeroomega');
  assert.equal(f.storage.proxyEnabled, false);
  assert.equal(f.storage.externalPreviewEnabled, false);
  assert.deepEqual(f.storage.connection, connection);
  f.control('other');
  const before = await f.chrome.proxy.settings.get();
  assert.equal((await f.send({ type: 'proxy.set', enabled: true })).ok, true);
  assert.equal(f.storage.externalPreviewEnabled, true);
  assert.equal(f.calls.set.length, 1, 'only the initial built-in mode wrote a PAC');
  assert.deepEqual(await f.chrome.proxy.settings.get(), before);
  assert.equal((await f.send({ type: 'connection.disconnect' })).ok, true);
  assert.equal(f.storage.connectionEnabled, false);
  assert.equal(f.storage.connection, undefined);
  assert.equal(f.storage.externalPreviewEnabled, false);
  assert.deepEqual(await f.chrome.proxy.settings.get(), before, 'disconnect must not rewrite ZeroOmega settings');
});

test('switching back to built-in requires explicit enabling and does not steal ZeroOmega control', async () => {
  const f = await fixture({ proxyMode: 'zeroomega', externalPreviewEnabled: true }, 'other');
  assert.equal((await f.send({ type: 'proxy.mode', mode: 'builtin' })).ok, true);
  assert.equal(f.storage.externalPreviewEnabled, false);
  assert.equal(f.calls.set.length, 0);
  assert.equal((await f.send({ type: 'proxy.set', enabled: true })).ok, false);
  f.control('available');
  assert.equal((await f.send({ type: 'proxy.set', enabled: true })).ok, true);
  assert.equal(f.calls.set.length, 1);
});

test('invalid mode is rejected without changing proxy ownership', async () => {
  const f = await fixture();
  const result = await f.send({ type: 'proxy.mode', mode: 'invalid' });
  assert.equal(result.ok, false);
  assert.equal(f.calls.set.length, 0);
  assert.equal(f.calls.clear.length, 0);
  assert.equal(f.storage.proxyMode, undefined);
});

test('ZeroOmega uses dynamic proxy authentication, scoped to the exact preview host and configured proxy endpoint', async () => {
  const f = await fixture({ proxyMode: 'zeroomega' }, 'other');
  await f.send({ type: 'proxy.set', enabled: true });
  const details = {
    isProxy: true, url: `https://${HOST}:8101/`,
    challenger: { host: '192.168.1.20', port: 18420 },
  };
  const result = await f.auth(details);
  assert.equal(result.authCredentials.username, 'preview');
  assert.equal(result.authCredentials.password, 'd'.repeat(64), 'never send the static pairing token');
  for (const change of [
    { isProxy: false },
    { url: 'https://other.example/' },
    { url: `https://${HOST}.evil.example/` },
    { challenger: { host: '192.168.1.21', port: 18420 } },
    { challenger: { host: '192.168.1.20', port: 18421 } },
  ]) {
    const before = f.calls.fetch.length;
    const ignored = await f.auth({ ...details, ...change });
    assert.equal(ignored.authCredentials, undefined);
    assert.equal(f.calls.fetch.length, before, 'unrelated auth must not reconnect or leak credentials');
  }
  await f.send({ type: 'connection.disconnect' });
  assert.equal((await f.auth(details)).cancel, true, 'explicit disconnect must not reconnect to satisfy proxy authentication');
});

test('global proxy errors are not attributed to this extension in ZeroOmega, inactive, or foreign-controlled modes', async () => {
  for (const [initial, controller] of [
    [{ proxyMode: 'zeroomega', externalPreviewEnabled: true }, 'other'],
    [{ proxyEnabled: false }, 'available'],
    [{ proxyEnabled: true }, 'other'],
    [{ proxyEnabled: true }, 'policy'],
  ]) {
    const f = await fixture(initial, controller);
    await f.proxyError();
    assert.equal(f.calls.errors.length, 0);
    assert.equal(f.storage.proxyError, undefined);
  }
});

test('our active built-in proxy errors are visible in settings and clear on retry or disabling', async () => {
  const f = await fixture();
  await f.send({ type: 'proxy.set', enabled: true });
  await f.proxyError();
  assert.equal((await f.send({ type: 'settings.get' })).data.proxyError, 'net::ERR_PROXY_CONNECTION_FAILED');
  assert.equal(f.calls.errors.length, 1);
  assert.ok(!JSON.stringify(f.calls.errors).includes('Do not log raw details.'));
  await f.send({ type: 'proxy.set', enabled: true });
  assert.equal(f.storage.proxyError, '');
  await f.proxyError();
  await f.send({ type: 'proxy.set', enabled: false });
  assert.equal(f.storage.proxyError, '');
});
