import { OwnedProcess } from './process.js';
import { MAX_MESSAGE, record, type JsonObject } from './util.js';

export class UnknownResultError extends Error {}
export class RpcRejected extends Error {}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class JsonLineClient {
  readonly process: OwnedProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closing = false;
  private failed = false;
  private incoming: Promise<void> = Promise.resolve();
  private incomingCount = 0;
  private incomingBytes = 0;
  constructor(
    argv: string[], directory: string,
    private readonly receive: (message: JsonObject) => Promise<void>,
    private readonly failure: (message: string) => void,
  ) {
    this.process = new OwnedProcess(argv, directory);
  }
  async start(): Promise<void> {
    const stdout = this.process.child.stdout;
    stdout.on('data', (data: Buffer) => {
      if (this.closing || this.failed) return;
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        let index: number;
        while ((index = this.buffer.indexOf(10)) !== -1) {
          if (index + 1 > MAX_MESSAGE) throw new Error('Oversized Agent JSONL');
          const message = record(JSON.parse(this.buffer.subarray(0, index).toString('utf8')));
          this.buffer = this.buffer.subarray(index + 1);
          if ('method' in message) {
            const size = index + 1;
            this.incomingBytes += size;
            if (++this.incomingCount > 128 || this.incomingBytes > 4 * MAX_MESSAGE) throw new Error('Agent notification queue exceeded');
            this.incoming = this.incoming.then(async () => {
              if (!this.closing && !this.failed) await this.receive(message);
            }).catch(() => this.fail('Invalid Agent protocol notification')).finally(() => { this.incomingCount--; this.incomingBytes -= size; });
          } else {
            if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) throw new Error('Invalid RPC response ID');
            const pending = this.pending.get(message.id);
            if (!pending) continue;
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if ('error' in message) pending.reject(new RpcRejected('Agent explicitly rejected the RPC request'));
            else if ('result' in message) pending.resolve(message.result);
            else { pending.reject(new UnknownResultError('Malformed RPC response; result unknown')); throw new Error('Invalid RPC response'); }
          }
        }
        if (this.buffer.length > MAX_MESSAGE) throw new Error('Oversized Agent JSONL');
      } catch {
        this.fail('Invalid or oversized Agent JSONL; execution result may be unknown');
      }
    });
    void this.process.exited.then(
      () => this.fail('Agent process exited; execution result may be unknown'),
      () => this.fail('Agent process could not be started'),
    );
    if (this.process.child.pid === undefined) await this.process.exited;
  }
  private fail(message: string): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new UnknownResultError(message));
    }
    this.pending.clear();
    this.failure(message);
  }
  async request(method: string, params: JsonObject, timeout = 20000): Promise<unknown> {
    if (this.closing || this.failed) throw new UnknownResultError('Agent connection is unavailable');
    if (this.pending.size >= 32) throw new Error('Too many pending RPC requests');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UnknownResultError(`Agent ${method} timed out; execution result unknown`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => undefined);
    });
  }
  private async write(value: unknown): Promise<void> {
    if (this.closing || this.failed) throw new UnknownResultError('Agent connection is unavailable');
    try { await this.process.write(value); }
    catch {
      const message = 'Agent input failed; execution result unknown';
      this.fail(message);
      throw new UnknownResultError(message);
    }
  }
  notify(method: string, params: JsonObject): Promise<void> { return this.write({ method, params }); }
  respond(id: string | number, result: unknown): Promise<void> { return this.write({ id, result }); }
  respondError(id: string | number, code: number, message: string): Promise<void> { return this.write({ id, error: { code, message } }); }
  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer); pending.reject(new UnknownResultError('Agent stopped; execution result unknown'));
      }
      this.pending.clear();
    }
    await this.process.close();
    await this.incoming;
  }
}
