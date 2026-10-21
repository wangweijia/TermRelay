import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, MAX_MESSAGE } from './util.js';

export const supervisorPath = join(__dirname, '..', 'termrelay-supervisor');

export class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number>;
  private closing?: Promise<void>;
  constructor(argv: string[], directory: string) {
    this.child = spawn(supervisorPath, argv, { cwd: directory, env: childEnvironment(), stdio: 'pipe' });
    this.exited = new Promise((resolve, reject) => {
      this.child.once('error', () => reject(new Error('Could not start Agent supervisor')));
      this.child.once('exit', code => resolve(code ?? 1));
    });
    // Every owner also observes `exited`; this prevents a spawn error becoming unhandled before start().
    void this.exited.catch(() => undefined);
    this.child.stderr.resume();
    this.child.stdin.on('error', () => { /* Exit is reported through exited / RPC pending requests. */ });
  }
  async write(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE || this.child.stdin.writableLength > 2 * MAX_MESSAGE) throw new Error('Agent input buffer exceeded');
    if (this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error('Agent process is closed');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, error => error ? reject(new Error('Agent input failed')) : resolve());
    });
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.child.stdin.end();
    const abort = new AbortController();
    try {
      const completed = await Promise.race([
        this.exited.then(() => true),
        delay(5000, false, { signal: abort.signal }),
      ]);
      if (!completed) {
        this.child.kill('SIGTERM');
        const terminated = await Promise.race([this.exited.then(() => true), delay(3000, false, { signal: abort.signal })]);
        if (!terminated) {
          this.child.kill('SIGKILL');
          await this.exited;
          throw new Error('Supervisor cleanup timed out; inspect the service cgroup for descendants');
        }
      }
    } finally { abort.abort(); }
  }
}

export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = new OwnedProcess(['--lock', path], dirname(path));
  try {
    const [chunk] = await Promise.race([
      once(owner.child.stdout, 'data'),
      owner.exited.then(code => { throw new Error(code === 2 ? 'Agent is running or configuration is locked; stop it first' : 'Cannot acquire Agent lock'); }),
    ]);
    if (String(chunk).trim() !== 'locked') throw new Error('Invalid Agent lock response');
    return await action();
  } finally { await owner.close(); }
}

export function locked(path: string): boolean {
  const result = spawnSync(supervisorPath, ['--lock-check', path], { env: childEnvironment(), stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status === 2) return true;
  if (result.status !== 0) throw new Error('Cannot inspect Agent configuration lock');
  return false;
}
