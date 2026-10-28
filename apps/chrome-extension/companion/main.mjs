import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UUID } from './model.mjs';
import { Store } from './store.mjs';
import { createCompanion } from './server.mjs';

const { values } = parseArgs({ options: {
  session: { type: 'string' },
  device: { type: 'string' },
  workspace: { type: 'string' },
  name: { type: 'string' },
  ports: { type: 'string', default: '8080' },
  port: { type: 'string', default: '18420' },
  'owner-port': { type: 'string', default: '18421' },
  'data-dir': { type: 'string', default: new URL('../.local/', import.meta.url).pathname },
  'parent-pid': { type: 'string' },
  help: { type: 'boolean' },
} });

if (values.help || !values.session) {
  console.log('node companion/main.mjs --session <local ACP session UUID> --device <device UUID> --workspace <opaque workspace ID> [--ports 8080,8081] [--data-dir PATH]');
  process.exit(values.help ? 0 : 1);
}
if (!UUID.test(values.session) || !UUID.test(values.device ?? '')
  || !values.workspace?.trim() || values.workspace.length > 256) {
  throw new Error('A local App session, device UUID and opaque workspace ID are required.');
}
const portOf = value => {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid port: ${value}`);
  return Number(value);
};
const ports = [...new Set(values.ports.split(',').map(portOf))];
const publicPort = portOf(values.port);
const ownerPort = portOf(values['owner-port']);
if (publicPort === ownerPort) throw new Error('Public and owner ports must differ.');
const parentPID = values['parent-pid'] === undefined ? undefined : Number(values['parent-pid']);
if (parentPID !== undefined && (!Number.isSafeInteger(parentPID) || parentPID < 2)) throw new Error('Invalid parent PID.');
const directory = resolve(values['data-dir']);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = resolve(directory, 'running.lock');
try { await mkdir(lock); }
catch (error) {
  if (error.code === 'EEXIST') throw new Error(`Companion is already running, or a stale lock exists: ${lock}. Verify the old process has stopped before removing only that lock directory.`);
  throw error;
}
let app;
let parentTimer;
let closing = false;
const cleanup = async () => {
  if (closing) return;
  closing = true;
  clearInterval(parentTimer);
  if (app) {
    app.closeProxy();
    await Promise.all([app.publicServer, app.adminServer].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  }
  await rm(lock, { recursive: true });
};
const shutdown = () => {
  cleanup().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
if (parentPID !== undefined) {
  parentTimer = setInterval(() => {
    if (process.ppid !== parentPID) shutdown();
  }, 1000);
}
try {
  const binding = {
    sessionId: values.session.toLowerCase(), deviceId: values.device.toLowerCase(), workspaceId: values.workspace,
    name: values.name || 'Local ACP session',
  };
  const configPath = resolve(directory, 'credentials.json');
  let credentials;
  try { credentials = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = () => randomBytes(32).toString('hex');
    credentials = {
      sessionId: binding.sessionId, deviceId: binding.deviceId, workspaceId: binding.workspaceId,
      reviewerToken: secret(), adminToken: secret(), proxyToken: secret(),
    };
    await writeFile(configPath, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' });
  }
  if (credentials.sessionId !== binding.sessionId || credentials.relay !== undefined
    || credentials.deviceId !== binding.deviceId || credentials.workspaceId !== binding.workspaceId) {
    throw new Error('This data directory belongs to another binding. Use a new --data-dir; do not silently rebind old feedback.');
  }
  if (['adminToken', 'reviewerToken', 'proxyToken'].some(key => !/^[0-9a-f]{64}$/.test(credentials[key] ?? ''))) {
    throw new Error('Credentials file has missing or invalid tokens; do not start with a partial configuration.');
  }
  const store = new Store(resolve(directory, 'feedback.json'));
  await store.load();
  app = createCompanion({ store, binding, ports, ...credentials });
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  await listen(app.adminServer, ownerPort, '127.0.0.1');
  await listen(app.publicServer, publicPort, '0.0.0.0');
  console.log(`Owner console: http://127.0.0.1:${ownerPort}`);
  console.log(`Feedback API + CONNECT proxy: port ${publicPort}; authorized project ports: ${ports.join(', ')}`);
  console.log(`Credentials (private; do not commit or log their values): ${configPath}`);
  console.log('Use adminToken in the owner console; share only reviewerToken and proxyToken with authorized testers.');
  console.log('Do not edit this project in another AI turn while a feedback execution is in progress.');
} catch (error) {
  await cleanup();
  throw error;
}
