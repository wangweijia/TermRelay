import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolEventPayload } from '@termrelay/contracts';
import { CodexRuntime } from '../../src/codex.js';
import { JsonLineClient } from '../../src/rpc.js';
import { Protocol, type Packet } from '../../src/protocol.js';

async function main(): Promise<void> {
  const events: ToolEventPayload[] = [];
  const runtime = new CodexRuntime('synthetic', tmpdir(), event => events.push(event),
    (_argv, cwd, receive, fail) => new JsonLineClient([process.execPath, join(__dirname, 'fake-codex.js')], cwd, receive, fail));
  try {
    await runtime.start(); runtime.publishConfiguration();
    await runtime.command('tool.turn.start', { text: 'synthetic' }, randomUUID());
    const end = Date.now() + 5000;
    while (!events.some(e => e.kind === 'turn.completed')) {
      if (Date.now() > end) throw new Error('Synthetic provider timed out');
      await delay(10);
    }
    await runtime.receive({ method: 'turn/started', params: { threadId: runtime.threadId, turn: { id: 'interactions' } } });
    const common = { threadId: runtime.threadId, turnId: runtime.turnId, itemId: 'item' };
    for (const [method, extra] of [
      ['item/reasoning/textDelta', { delta: 'reasoning' }], ['item/plan/delta', { delta: 'plan' }],
      ['item/commandExecution/outputDelta', { delta: 'output' }],
      ['item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'echo synthetic' } }],
      ['item/completed', { item: { id: 'cmd', type: 'commandExecution', exitCode: 0 } }],
      ['item/completed', { item: { id: 'file', type: 'fileChange', changes: [] } }],
    ] as const) await runtime.receive({ method, params: { ...common, ...extra } });
    await runtime.setAutoApprove(true);
    for (const [method, extra] of [
      ['item/commandExecution/requestApproval', { command: 'echo synthetic' }],
      ['item/fileChange/requestApproval', { reason: 'synthetic' }],
      ['item/permissions/requestApproval', { permissions: { network: { enabled: true } } }],
      ['item/tool/requestUserInput', { questions: [{ id: 'q', header: '', question: '?' }], autoResolutionMs: 10000 }],
    ] as const) await runtime.receive({ id: 100, method, params: { ...common, ...extra } });
    const requestId = runtime.questions.keys().next().value!;
    await runtime.command('tool.user-input.resolve', { requestId, turnId: runtime.turnId, answers: { q: ['yes'] } }, randomUUID());
    runtime.emit('warning', { code: 'synthetic', message: 'synthetic' });
    runtime.emit('error', { code: 'synthetic', message: 'synthetic' });
  } finally { await runtime.close(); }
  const packets: Packet[] = [], id = randomUUID(), workspace = randomUUID();
  const protocol = new Protocol(randomUUID(), 'Linux synthetic', value => packets.push(value), () => undefined);
  protocol.tools = ['codex']; protocol.addWorkspace(workspace, 'Synthetic'); protocol.start(id, workspace, 'codex', 'acp');
  protocol.connected(); protocol.publish('workspace.registered', protocol.workspaces.get(workspace));
  protocol.publish('session.started', protocol.sessions.get(id)!.started, id, { seq: 0 });
  events.forEach((event, i) => protocol.publish('tool.event', event, id, { seq: i + 1 }));
  protocol.publish('session.sync', {}, id); protocol.end(id); protocol.publish('session.ended', protocol.sessions.get(id)!.ended, id);
  console.log(JSON.stringify(packets));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture failed'); process.exitCode = 1; });
