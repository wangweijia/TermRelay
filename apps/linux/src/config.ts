import {
  closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, linkSync,
  mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isErrno, record, serverURL, text, UUID } from './util.js';

export interface Workspace { id: string; name: string; path: string; remoteStartAllowed?: boolean }
export interface Profile { id: string; workspaceId: string; provider: 'shell' | 'codex' }
export interface Config {
  version: 1; deviceId: string; name: string; serverURL: string;
  workspaces: Workspace[]; sessions: Profile[]; tools: { codex?: string }; credentialFile?: string;
}

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'termrelay', 'agent.json');
}

function id(value: unknown): string {
  const result = text(value);
  if (!UUID.test(result)) throw new Error('Invalid UUID in Agent configuration');
  return result;
}

export function validateConfig(input: unknown): Config {
  const value = record(input);
  if (value.version !== 1) throw new Error('Unsupported Agent configuration version');
  const deviceId = id(value.deviceId);
  const url = text(value.serverURL, 8192);
  serverURL(url);
  if (!Array.isArray(value.workspaces) || value.workspaces.length > 128
      || !Array.isArray(value.sessions) || value.sessions.length > 8) throw new Error('Limit: 128 workspaces and 8 startup sessions');
  const workspaces = value.workspaces.map(input => {
    const w = record(input);
    const path = text(w.path, 4096);
    if (!isAbsolute(path)) throw new Error('Workspace path must be absolute');
    if (w.remoteStartAllowed !== undefined && typeof w.remoteStartAllowed !== 'boolean') throw new Error('Invalid remote workspace authorization');
    return { id: id(w.id), name: text(w.name, 128), path, ...(w.remoteStartAllowed !== undefined ? { remoteStartAllowed: w.remoteStartAllowed } : {}) };
  });
  if (new Set(workspaces.map(w => w.id)).size !== workspaces.length
      || new Set(workspaces.map(w => w.name)).size !== workspaces.length
      || new Set(workspaces.map(w => w.path)).size !== workspaces.length) throw new Error('Duplicate workspace');
  const sessions = value.sessions.map<Profile>(input => {
    const s = record(input);
    const workspaceId = id(s.workspaceId);
    if (!workspaces.some(w => w.id === workspaceId) || (s.provider !== 'shell' && s.provider !== 'codex')) throw new Error('Invalid startup session');
    return { id: id(s.id), workspaceId, provider: s.provider };
  });
  if (new Set(sessions.map(s => s.id)).size !== sessions.length) throw new Error('Duplicate startup profile');
  const tools = record(value.tools);
  if (Object.keys(tools).some(key => key !== 'codex')) throw new Error('Only codex tool configuration is supported');
  const config: Config = {
    version: 1, deviceId, serverURL: url, name: text(value.name, 128), workspaces, sessions, tools: {},
  };
  if (tools.codex !== undefined) {
    const path = text(tools.codex, 4096);
    if (!isAbsolute(path)) throw new Error('Tool path must be absolute');
    config.tools.codex = path;
  }
  if (value.credentialFile !== undefined) {
    const path = text(value.credentialFile, 4096);
    if (!isAbsolute(path)) throw new Error('Credential file must be absolute');
    config.credentialFile = path;
  }
  return config;
}

export function writePrivateJSON(path: string, value: unknown, replace = true): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (replace) renameSync(temporary, path);
    else { linkSync(temporary, path); unlinkSync(temporary); }
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class ConfigStore {
  readonly path: string;
  constructor(path = configPath()) { this.path = resolve(path); }
  get lockPath(): string { return this.path.replace(/\.json$/, '') + '.lock'; }
  get statusPath(): string { return this.path.replace(/\.json$/, '') + '.status.json'; }
  load(): Config {
    try { return validateConfig(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch (error) {
      if (isErrno(error, 'ENOENT')) throw new Error('Agent is not configured; run configure first');
      throw error;
    }
  }
  save(config: Config): void { writePrivateJSON(this.path, validateConfig(config)); }
  configure(url: string, name?: string): Config {
    serverURL(url);
    const config: Config = existsSync(this.path) ? this.load() : {
      version: 1, deviceId: randomUUID(), name: hostname().slice(0, 128), serverURL: url,
      workspaces: [], sessions: [], tools: {},
    };
    if (config.serverURL !== url) delete config.credentialFile;
    config.serverURL = url;
    if (name !== undefined) config.name = name;
    this.save(config);
    return config;
  }
}

export function credential(value: unknown): string {
  const token = text(value, 240);
  if (/\s/.test(token)) throw new Error('Invalid device credential');
  return token;
}

export function readCredential(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERMRELAY_DEVICE_CREDENTIAL) return credential(env.TERMRELAY_DEVICE_CREDENTIAL);
  const systemd = env.CREDENTIALS_DIRECTORY;
  const path = systemd ? join(systemd, 'device-credential') : config.credentialFile;
  if (!path) return '';
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new Error('Credential must be a private, current-user-owned regular file of at most 4 KiB');
    }
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  if (systemd) return credential(raw.trim());
  const value = record(JSON.parse(raw));
  if (value.serverURL !== config.serverURL || value.deviceId !== config.deviceId) throw new Error('Credential belongs to another Server or device');
  return credential(value.credential);
}
