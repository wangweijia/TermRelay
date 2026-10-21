import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigStore, readCredential, validateConfig, writePrivateJSON } from '../src/config.js';
import { childEnvironment } from '../src/util.js';
import { locked, withLock } from '../src/process.js';
import { pairDevice } from '../src/pairing.js';

function temporary(t: { after(fn: () => void): void }): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'termrelay-ts-config-')));
  t.after(() => rmSync(path, { recursive: true }));
  return path;
}

test('private configuration retains device/workspace IDs and rejects corruption', t => {
  const directory = temporary(t), store = new ConfigStore(join(directory, 'agent.json'));
  const config = store.configure('ws://localhost:3007/ws/client', 'Linux');
  assert.equal(store.configure(config.serverURL).deviceId, config.deviceId);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  for (const value of [null, { ...config, version: true }, { ...config, deviceId: 3 }, { ...config, sessions: [{}] }, { ...config, serverURL: 'ws://host/ws/client-public' }]) {
    assert.throws(() => validateConfig(value));
  }
  writePrivateJSON(store.path, {});
  assert.throws(() => store.configure(config.serverURL));
  assert.deepEqual(JSON.parse(readFileSync(store.path, 'utf8')), {});
});

test('credentials enforce owner/mode, server/device binding and no symlinks', t => {
  const directory = temporary(t), store = new ConfigStore(join(directory, 'agent.json'));
  const config = store.configure('wss://example.com/ws/client-public');
  const path = join(directory, 'credential');
  writePrivateJSON(path, { serverURL: config.serverURL, deviceId: config.deviceId, credential: 'synthetic-secret' });
  config.credentialFile = path;
  assert.equal(readCredential(config, {}), 'synthetic-secret');
  assert.throws(() => readCredential({ ...config, serverURL: 'wss://other/ws/client-public' }, {}));
  chmodSync(path, 0o644);
  assert.throws(() => readCredential(config, {}));
  chmodSync(path, 0o600);
  symlinkSync(path, join(directory, 'link'));
  assert.throws(() => readCredential({ ...config, credentialFile: join(directory, 'link') }, {}));
  const old = process.env.TERMRELAY_DEVICE_CREDENTIAL;
  process.env.TERMRELAY_DEVICE_CREDENTIAL = 'synthetic-secret';
  try { assert.equal(childEnvironment().TERMRELAY_DEVICE_CREDENTIAL, undefined); }
  finally { if (old === undefined) delete process.env.TERMRELAY_DEVICE_CREDENTIAL; else process.env.TERMRELAY_DEVICE_CREDENTIAL = old; }
});

test('native configuration lock excludes concurrent edits and releases on EOF', async t => {
  const directory = temporary(t), path = join(directory, 'agent.lock');
  await withLock(path, async () => {
    assert.equal(locked(path), true);
    await assert.rejects(withLock(path, async () => undefined), /locked|running/);
  });
  assert.equal(locked(path), false);
  await withLock(path, async () => undefined);
});

test('CLI is TypeScript/Node only and persists startup profiles', t => {
  const directory = temporary(t), config = join(directory, 'agent.json');
  const run = (...args: string[]) => spawnSync(process.execPath, [join(__dirname, '../src/cli.js'), '--config', config, ...args], { encoding: 'utf8' });
  assert.equal(run('--help').status, 0);
  assert.equal(run('configure', '--server', 'ws://localhost:3007/ws/client').status, 0);
  assert.equal(run('workspace', 'add', directory, '--name', 'project').status, 0);
  assert.equal(run('session', 'add', '--workspace', 'project', '--provider', 'codex').status, 0);
  const store = new ConfigStore(config), value = store.load();
  assert.equal(value.sessions.length, 1);
  assert.equal(run('workspace', 'remove', 'project').status, 1);
  assert.equal(run('session', 'remove', value.sessions[0]!.id).status, 0);
  assert.equal(run('workspace', 'remove', 'project').status, 0);
});

test('headless pairing trusts same-origin HTTPS and does not print secrets', async t => {
  const directory = temporary(t), store = new ConfigStore(join(directory, 'agent.json'));
  const config = store.configure('wss://example.com/ws/client-public');
  const output: string[] = [];
  const fake: typeof fetch = async input => {
    const url = new URL(String(input));
    return Response.json(url.pathname.endsWith('/token') ? { status: 'issued', credential: 'synthetic-secret' } : {
      pairingId: 'pair', deviceCode: 'device', userCode: 'CODE', verificationURL: 'https://example.com/pair',
      expiresIn: 60, pollInterval: 1,
    });
  };
  await pairDevice(store, config, join(directory, 'credential'), { fetch: fake, sleep: async () => undefined, print: value => output.push(value) });
  assert.equal(readCredential(store.load(), {}), 'synthetic-secret');
  assert.equal(output.join('').includes('synthetic-secret'), false);
  await assert.rejects(pairDevice(store, config, store.path, { fetch: fake }), /overwrite/);
  assert.throws(() => writePrivateJSON(store.path, {}, false));
});
