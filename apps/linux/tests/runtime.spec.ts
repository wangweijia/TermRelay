import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonLineClient, RpcRejected, UnknownResultError } from '../src/rpc.js';
import { TerminalRuntime } from '../src/pty.js';
import { CodexRuntime, type RpcConnection, type RpcFactory } from '../src/codex.js';
import type { ToolEventPayload } from '@termrelay/contracts';
import type { JsonObject } from '../src/util.js';
import { randomUUID } from 'node:crypto';

export const fixture = join(__dirname, 'fixtures/fake-codex.js');
export const fixtureClient: RpcFactory = (_argv, cwd, receive, fail) => new JsonLineClient([process.execPath, fixture], cwd, receive, fail);
export async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() >= end) throw new Error('Condition timed out'); await delay(10); }
}
export class MemoryClient implements RpcConnection {
  sent: { id: string | number; result: unknown }[] = [];
  hook?: (method: string, params: JsonObject) => Promise<unknown>;
  async start(): Promise<void> {}
  async request(method: string, params: JsonObject): Promise<unknown> {
    if (this.hook) return this.hook(method, params);
    return { turn: { id: 'turn' } };
  }
  async notify(): Promise<void> {}
  async respond(id: string | number, result: unknown): Promise<void> { this.sent.push({ id, result }); await delay(0); }
  async respondError(id: string | number, code: number): Promise<void> { this.sent.push({ id, result: { code } }); }
  async close(): Promise<void> {}
}

test('real stdio synthetic provider handshakes, configures and completes ordered turn', async () => {
  const events: ToolEventPayload[] = [];
  const runtime = new CodexRuntime('unused', tmpdir(), event => events.push(event), fixtureClient);
  try {
    await runtime.start(); runtime.publishConfiguration();
    assert.equal(runtime.configuration()[0]!.currentValue, 'synthetic');
    await runtime.command('tool.config.set', { id: 'effort', value: 'high' }, randomUUID());
    await runtime.command('tool.turn.start', { text: 'hello' }, randomUUID());
    await until(() => events.some(e => e.kind === 'turn.completed'));
    const kinds = events.map(e => e.kind);
    assert.ok(kinds.indexOf('user.message') < kinds.indexOf('assistant.delta'));
    assert.ok(kinds.includes('assistant.completed')); assert.equal(runtime.busy, false);
  } finally { await runtime.close(); }
});

test('RPC rejects explicitly, times out without replay and surfaces invalid JSONL', async () => {
  const failures: string[] = [];
  const client = new JsonLineClient([process.execPath, fixture], tmpdir(), async () => undefined, message => failures.push(message));
  try {
    await client.start();
    assert.deepEqual(await client.request('test/echo', { text: 'hello' }), { text: 'hello' });
    await assert.rejects(client.request('test/error', {}), error => error instanceof RpcRejected && !error.message.includes('sensitive'));
    await assert.rejects(client.request('test/no-response', {}, 30), UnknownResultError);
    await assert.rejects(client.request('test/malformed', {}), UnknownResultError);
    assert.equal(failures.length, 1);
  } finally { await client.close(); }
});

test('Codex approvals/questions are correlated, deduplicated and auto approval follows Server state', async () => {
  const events: ToolEventPayload[] = [], client = new MemoryClient();
  const runtime = new CodexRuntime('unused', tmpdir(), e => events.push(e), () => client);
  runtime.threadId = 'thread'; runtime.turnId = 'turn'; runtime.busy = true;
  const request = (method: string, extra: JsonObject = {}) => runtime.receive({
    id: 50, method, params: { threadId: 'thread', turnId: 'turn', itemId: 'item', ...extra },
  });
  await request('item/commandExecution/requestApproval', { command: 'echo ok', proposedExecpolicyAmendment: ['echo'] });
  const approvalId = events.at(-1)!.data.approvalId;
  const payload = { approvalId, turnId: 'turn', decision: 'allowPolicy' };
  const resolutions = await Promise.allSettled([runtime.command('tool.approval.resolve', payload, randomUUID()), runtime.command('tool.approval.resolve', payload, randomUUID())]);
  assert.equal(resolutions.filter(r => r.status === 'rejected').length, 1);
  assert.equal(client.sent.length, 1);
  await runtime.setAutoApprove(true);
  await request('item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
  assert.deepEqual(client.sent.at(-1)!.result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  await request('item/tool/requestUserInput', { questions: [{ id: 'q', header: '', question: '?' }], autoResolutionMs: 10000 });
  const data = events.at(-1)!.data;
  assert.equal(data.isBlocking, true); assert.ok(data.expiresAt);
  await runtime.command('tool.user-input.resolve', { requestId: data.requestId, turnId: 'turn', answers: { q: ['yes'] } }, randomUUID());
  assert.deepEqual(client.sent.at(-1)!.result, { answers: { q: { answers: ['yes'] } } });
  await assert.rejects(runtime.command('tool.user-input.resolve', { requestId: data.requestId, turnId: 'turn', answers: { q: ['yes'] } }, randomUUID()));
});

test('unknown execution result holds busy; explicit RPC rejection releases it; response races are safe', async () => {
  const client = new MemoryClient(), events: ToolEventPayload[] = [];
  const runtime = new CodexRuntime('unused', tmpdir(), e => events.push(e), () => client);
  runtime.threadId = 'thread';
  client.hook = async () => { throw new UnknownResultError('unknown'); };
  await assert.rejects(runtime.command('tool.turn.start', { text: 'hi' }, randomUUID()));
  assert.equal(runtime.busy, true);
  runtime.busy = false;
  client.hook = async () => { throw new RpcRejected('rejected'); };
  await assert.rejects(runtime.command('tool.turn.start', { text: 'hi' }, randomUUID()));
  assert.equal(runtime.busy, false);
  client.hook = async () => {
    await runtime.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    return { turn: { id: 'turn' } };
  };
  await runtime.command('tool.turn.start', { text: 'hi' }, randomUUID());
  assert.equal(runtime.busy, false);
  runtime.turnId = 'new'; runtime.busy = true;
  await runtime.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  assert.equal(runtime.busy, true); assert.equal(runtime.turnId, 'new');
});

test('real PTY preserves Unicode, resize, input, interrupt and stop', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'termrelay-ts-pty-')));
  t.after(() => rmSync(directory, { recursive: true }));
  let output = '', exited = false;
  const terminal = new TerminalRuntime(directory, event => {
    if (event.kind === 'output') output += event.data.toString();
    if (event.kind === 'exit') exited = true;
    if (event.kind === 'error') output += `ERROR:${event.error.message}`;
  }, '/bin/sh');
  try {
    await terminal.command('terminal.resize', { columns: 111, rows: 37 });
    await terminal.command('terminal.input', { data: Buffer.from("stty size; printf '中文\\n__READY__\\n'\n").toString('base64') });
    await until(() => output.includes('37 111') && output.includes('中文\r\n__READY__'));
    await terminal.command('terminal.input', { data: Buffer.from('sleep 60\n').toString('base64') });
    await delay(50); await terminal.command('session.interrupt', {});
    await terminal.command('terminal.input', { data: Buffer.from("printf '\\n__AFTER__\\n'\n").toString('base64') });
    await until(() => output.includes('\r\n__AFTER__\r\n'));
  } finally { await terminal.close(); }
  assert.equal(exited, true);
});

test('Linux subreaper cleans detached provider descendants on stdin EOF', { skip: process.platform !== 'linux' }, async () => {
  const client = new JsonLineClient([process.execPath, fixture], tmpdir(), async () => undefined, () => undefined);
  let pid = 0;
  try {
    await client.start();
    const result = await client.request('test/fork', {}) as { pid: number };
    pid = result.pid;
  } finally { await client.close(); }
  await until(() => !existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z');
});
