import { constants, accessSync, statSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export const VERSION = text(record(JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))).version, 128);
export const MAX_MESSAGE = 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type JsonObject = Record<string, unknown>;

export function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as JsonObject;
}

export function text(value: unknown, max = 256, min = 1): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max) {
    throw new Error(`Expected text of ${min}-${max} characters`);
  }
  return value;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid integer');
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function serverURL(value: string): URL {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || !['/ws/client', '/ws/client-public'].includes(url.pathname)
      || (url.pathname === '/ws/client-public' && url.protocol !== 'wss:')) {
    throw new Error('Use ws(s)://host/ws/client or wss://host/ws/client-public');
  }
  return url;
}

export function executable(value: string): boolean {
  try {
    accessSync(value, constants.X_OK);
    return statSync(value).isFile();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EACCES')) return false;
    throw error;
  }
}

export function findExecutable(name: string): string | undefined {
  if (isAbsolute(name)) return executable(name) ? name : undefined;
  return (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)
    .map(path => join(path, name)).find(executable);
}

export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TERMRELAY_DEVICE_CREDENTIAL;
  delete env.CREDENTIALS_DIRECTORY;
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
  return env;
}
