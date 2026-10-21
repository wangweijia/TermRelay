const { join, resolve } = require('node:path');

async function main() {
  const root = resolve(process.argv[2]);
  const { TerminalRuntime } = require(join(root, 'app/dist/src/pty.js'));
  let output = '';
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error(`Staged PTY output missing: ${output}`)), 7000);
  const terminal = new TerminalRuntime(root, event => {
    if (event.kind === 'output') {
      output += event.data.toString();
      if (output.includes('中文\r\nSTAGED_OK\r\n')) resolveReady();
    } else if (event.kind === 'error') rejectReady(event.error);
    else if (!output.includes('STAGED_OK\r\n')) rejectReady(new Error(`Staged PTY exited before output: ${event.code}`));
  }, '/bin/sh');
  try {
    await terminal.command('terminal.input', { data: Buffer.from("printf '中文\\nSTAGED_OK\\n'\n").toString('base64') });
    await ready;
  } finally {
    clearTimeout(timer);
    await terminal.close();
  }
  console.log('Private-runtime PTY smoke passed with no system Node/Python on PATH.');
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
