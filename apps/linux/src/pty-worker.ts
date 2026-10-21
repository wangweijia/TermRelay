import { spawn } from 'node-pty';
import { childEnvironment, integer, record, text } from './util.js';

const directory = text(process.argv[2], 4096);
const shell = text(process.argv[3], 4096);
const terminal = spawn(shell, ['-l'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: directory,
  env: childEnvironment(), encoding: null,
});
function emit(value: unknown): void {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) terminal.pause();
}
process.stdout.on('drain', () => terminal.resume());
process.stdout.on('error', error => {
  console.error(`PTY output failed: ${error.code ?? 'stream error'}`);
  terminal.kill();
  process.exitCode = 1;
});
terminal.onData(data => emit({ kind: 'output', data: Buffer.from(data).toString('base64') }));
terminal.onExit(event => {
  emit({ kind: 'exit', code: event.exitCode, signal: event.signal ?? 0 });
  process.stdin.destroy();
});
emit({ kind: 'ready' });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data: string) => {
  try {
    buffer += data;
    if (Buffer.byteLength(buffer) > 262144) throw new Error('PTY input buffer exceeded');
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const message = record(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
      switch (message.kind) {
        case 'input': terminal.write(Buffer.from(text(message.data, 87384), 'base64')); break;
        case 'resize': terminal.resize(integer(message.columns, 1, 1000), integer(message.rows, 1, 1000)); break;
        case 'interrupt': terminal.write('\x03'); break;
        case 'stop': terminal.kill(); break;
        default: throw new Error('Unknown PTY control');
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PTY control failed');
    terminal.kill(); process.exitCode = 1;
  }
});
process.stdin.on('end', () => terminal.kill());
