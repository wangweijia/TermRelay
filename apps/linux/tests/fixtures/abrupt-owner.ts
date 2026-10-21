import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonLineClient } from '../../src/rpc.js';

async function main(): Promise<void> {
  const client = new JsonLineClient([process.execPath, join(__dirname, 'fake-codex.js')], tmpdir(), async () => undefined,
    message => { console.error(message); process.exitCode = 1; });
  await client.start();
  const result = await client.request('test/fork', {});
  process.stdout.write(JSON.stringify(result), () => process.kill(process.pid, 'SIGKILL'));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
