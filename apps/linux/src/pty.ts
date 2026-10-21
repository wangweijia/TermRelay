import { join } from 'node:path';
import { OwnedProcess } from './process.js';
import { MAX_MESSAGE, integer, record, text, type JsonObject } from './util.js';

export type PtyEvent = { kind: 'output'; data: Buffer } | { kind: 'exit'; code: number } | { kind: 'error'; error: Error };
export class TerminalRuntime {
  readonly process: OwnedProcess;
  private buffer = Buffer.alloc(0);
  stopping = false;
  constructor(directory: string, private readonly emit: (event: PtyEvent) => void, shell = process.env.SHELL || '/bin/bash') {
    this.process = new OwnedProcess([process.execPath, join(__dirname, 'pty-worker.js'), directory, shell], directory);
    this.process.child.stdout.on('data', (data: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        let index: number;
        while ((index = this.buffer.indexOf(10)) !== -1) {
          if (index > MAX_MESSAGE) throw new Error('PTY output frame exceeded');
          const value = record(JSON.parse(this.buffer.subarray(0, index).toString('utf8')));
          this.buffer = this.buffer.subarray(index + 1);
          if (value.kind === 'output') this.emit({ kind: 'output', data: Buffer.from(text(value.data, MAX_MESSAGE), 'base64') });
          else if (value.kind === 'exit') this.emit({ kind: 'exit', code: integer(value.code, 0, 255) });
          else throw new Error('Invalid PTY worker event');
        }
        if (this.buffer.length > MAX_MESSAGE) throw new Error('PTY output frame exceeded');
      } catch { this.emit({ kind: 'error', error: new Error('Invalid PTY worker output') }); }
    });
    void this.process.exited.then(
      code => this.emit({ kind: 'exit', code }),
      () => this.emit({ kind: 'error', error: new Error('PTY supervisor failed') }),
    );
  }
  async command(kind: string, payload: JsonObject): Promise<void> {
    switch (kind) {
      case 'terminal.input': await this.process.write({ kind: 'input', data: payload.data }); break;
      case 'terminal.resize': await this.process.write({ kind: 'resize', columns: payload.columns, rows: payload.rows }); break;
      case 'session.interrupt': await this.process.write({ kind: 'interrupt' }); break;
      case 'session.stop': this.stopping = true; await this.process.close(); break;
      default: throw new Error('Unsupported PTY command');
    }
  }
  async close(): Promise<void> { this.stopping = true; await this.process.close(); }
}
