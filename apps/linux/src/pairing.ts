import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore, credential, readCredential, writePrivateJSON, type Config } from './config.js';
import { VERSION, integer, record, serverURL, text, type JsonObject } from './util.js';

async function request(url: string, path: string, body: JsonObject, fetcher: typeof fetch): Promise<JsonObject> {
  const parsed = serverURL(url);
  if (parsed.protocol !== 'wss:' || parsed.pathname !== '/ws/client-public') throw new Error('Pairing requires wss://host/ws/client-public');
  const endpoint = new URL(path, `https://${parsed.host}`);
  const response = await fetcher(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Pairing HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty pairing response');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65536) throw new Error('Pairing response exceeds 64 KiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function pairDevice(
  store: ConfigStore, config: Config, destination: string,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; print?: (value: string) => void } = {},
): Promise<void> {
  const fetcher = options.fetch ?? fetch, sleep = options.sleep ?? delay, print = options.print ?? console.log;
  const path = resolve(destination);
  const reserved = [store.path, store.lockPath, store.statusPath];
  if (reserved.some(p => p === path || (existsSync(path) && existsSync(p) && realpathSync(path) === realpathSync(p)))) throw new Error('Credential cannot overwrite config, lock or status');
  const exists = existsSync(path);
  if (exists || (() => { try { return lstatSync(path).isSymbolicLink(); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; } })()) {
    if (config.credentialFile !== path) throw new Error('Credential destination already exists; choose a new file');
    readCredential(config, {});
  }
  const session = await request(config.serverURL, '/api/client-pairings', {
    deviceId: config.deviceId, deviceName: config.name, appVersion: VERSION,
  }, fetcher);
  const pairingId = text(session.pairingId), deviceCode = text(session.deviceCode), userCode = text(session.userCode);
  const verification = new URL(text(session.verificationURL, 8192));
  if (verification.protocol !== 'https:' || verification.host !== serverURL(config.serverURL).host
      || verification.username || verification.password) throw new Error('Untrusted pairing verification URL');
  const expires = integer(session.expiresIn, 1, 3600), interval = integer(session.pollInterval, 1, 60);
  print(`Open on any device: ${verification.href}\nPairing code: ${userCode}`);
  const deadline = Date.now() + expires * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(interval * 1000, deadline - Date.now()));
    if (Date.now() >= deadline) break;
    const result = await request(config.serverURL, '/api/client-pairings/token', { pairingId, deviceCode }, fetcher);
    if (result.status === 'authorization_pending') continue;
    if (result.status !== 'issued') throw new Error('Pairing denied, expired or invalid response');
    writePrivateJSON(path, { serverURL: config.serverURL, deviceId: config.deviceId, credential: credential(result.credential) }, exists);
    config.credentialFile = path; store.save(config);
    print('Paired. Credential saved to the explicitly selected private plaintext file; do not share or commit it.');
    return;
  }
  throw new Error('Pairing expired');
}
