import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import { controllerConversationSchema } from '@termrelay/contracts';
import type WebSocket from 'ws';
import type { Envelope, ControllerConversationPayload } from '@termrelay/contracts';
import type { SessionsService } from '../sessions/sessions.service';
import type { SessionEventRecord, SessionRecord } from '../sessions/session.repository';
import type { SessionEventListener, SessionStateListener } from '../sessions/sessions.service';
import type { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { CommandRelayService } from '../realtime/command-relay.service';
import { TurnCommandRepository } from '../realtime/turn-command.repository';
import { ControllerConversationService } from './controller-conversation.service';
import type { ControllerAuthorization } from './controller-auth.service';

function event(seq: number, kind: string, data: Record<string, unknown> = {}): SessionEventRecord {
  return { seq, type: 'tool.event', createdAt: new Date().toISOString(),
    payload: { kind, occurredAt: new Date().toISOString(), correlation: { turnId: 'turn', itemId: 'item' }, data: { turnId: 'turn', ...data } } };
}
function fixture() {
  let active = true;
  let notify: SessionEventListener = () => {}; let notifyState: SessionStateListener = () => {};
  const session = { id: 'session', deviceId: 'mac', workspaceId: 'opaque', toolKey: 'codex', displayName: '测试会话', runtimeMode: 'acp',
    status: 'running', stateVersion: 2, autoApproveEnabled: false, origin: 'local' } as SessionRecord;
  const events = [event(0, 'turn.started'), event(1, 'user.message', { text: 'hello' }), event(2, 'assistant.delta', { text: 'answer' })];
  let pending: SessionEventRecord[] = [];
  const sessions = {
    findById: async (id: string) => id === session.id ? { ...session } : undefined,
    listEvents: async (_id: string, after: number, limit: number) => events.filter(item => item.seq > after).slice(0, limit),
    listEventsBefore: async (_id: string, before: number, limit: number) => events.filter(item => item.seq < before).slice(-limit),
    listHumanRequests: async (_id: string, before: number | undefined, limit: number) => pending.filter(item => before === undefined || item.seq < before).slice(0, limit),
    findHumanRequest: async (_id: string, request: { kind: string; id: string; turnId: string }) => pending.find(item => item.payload.kind === request.kind
      && (item.payload.data as Record<string, unknown>).turnId === request.turnId
      && ((item.payload.data as Record<string, unknown>).approvalId ?? (item.payload.data as Record<string, unknown>).requestId) === request.id),
    markUserMessageIntent: async () => true,
    subscribe: (listener: SessionEventListener) => { notify = listener; return () => { notify = () => {}; }; },
    subscribeState: (listener: SessionStateListener) => { notifyState = listener; return () => { notifyState = () => {}; }; },
  };
  const sent: any[] = []; const mac = { send: (wire: string) => sent.push(JSON.parse(wire).data) } as unknown as WebSocket;
  const registry = { getClient: (id: string) => id === 'mac' ? mac : undefined, isRegisteredClient: (client: WebSocket) => client === mac } as unknown as DeviceConnectionRegistry;
  const records = new TurnCommandRepository();
  const relay = new CommandRelayService(registry, sessions as unknown as SessionsService, undefined, records);
  const service = new ControllerConversationService(sessions as unknown as SessionsService, relay, records); service.onModuleInit();
  const socket = {} as WebSocket; const responses: any[] = [];
  const auth: ControllerAuthorization = { role: 'controller', credentialId: 'credential', installationId: 'installation', deviceIds: ['mac'],
    permissions: ['sessions.read', 'turns.write', 'approvals.resolve', 'user-input.resolve'], expiresAt: null };
  const context = { auth, active: async () => active, send: (op: string, sessionId: string, body: unknown, relatedMessageId?: string) => responses.push({ op, sessionId, body, relatedMessageId }) };
  const request = async (op: ControllerConversationPayload['op'], extra: Partial<ControllerConversationPayload> = {}) => {
    const envelope = { type: 'controller.conversation', protocolVersion: '2', deviceId: 'installation', messageId: randomUUID(), sentAt: new Date().toISOString(),
      payload: { op, sessionId: 'session', ...extra } } as Envelope<ControllerConversationPayload>;
    await service.handle(socket, context, envelope); return responses.at(-1);
  };
  const sync = async () => { const result = await request('sync'); return result.body.syncId as string; };
  return { session, events, sessions, sent, mac, records, relay, service, socket, auth, responses, request, sync,
    revoke: () => { active = false; }, setPending: (value: SessionEventRecord[]) => { pending = value; },
    publish: (item: SessionEventRecord) => { events.push(item); session.stateVersion = item.seq; notify({ deviceId: 'mac', sessionId: 'session', event: item }); },
    state: () => notifyState(session), destroy: () => { service.onModuleDestroy(); relay.onModuleDestroy(); } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 180));

test('snapshot boundary buffers concurrent events, ready flushes them in order and scoped history stays bounded', async t => {
  const f = fixture(); t.after(f.destroy);
  const load = f.sessions.listEventsBefore;
  f.sessions.listEventsBefore = async (...args) => { f.publish(event(3, 'assistant.delta', { text: 'live' })); return load(...args); };
  const first = await f.request('sync');
  assert.equal(first.body.boundary, 2);
  assert.deepEqual(first.body.items.map((item: any) => item.seq), [0, 1, 2]);
  assert.equal(f.responses.filter(item => item.op === 'events').length, 0);
  f.sessions.listEventsBefore = load;
  await f.request('ready', { syncId: first.body.syncId }); await settle();
  const live = f.responses.find(item => item.op === 'events');
  assert.deepEqual(live.body.items.map((item: any) => item.seq), [3]);
  assert.equal(live.body.throughSeq, 3);
  assert.equal(live.sessionId, 'session');
  const history = await f.request('history', { syncId: first.body.syncId, beforeSeq: 100 });
  assert.ok(history.body.items.every((item: any) => item.seq <= 2));
});

test('only granted ACP sessions are readable and only one subscription survives switching or closing', async t => {
  const f = fixture(); t.after(f.destroy);
  await assert.rejects(f.request('sync', { sessionId: 'guessed' }), /unavailable/);
  f.auth.deviceIds = []; await assert.rejects(f.request('sync'), /unavailable/);
  f.auth.deviceIds = ['mac']; f.auth.permissions = []; await assert.rejects(f.request('sync'), /unavailable/);
  f.auth.permissions = ['sessions.read']; f.session.runtimeMode = 'pty'; await assert.rejects(f.request('sync'), /unavailable/);
  f.session.runtimeMode = 'acp'; const prior = await f.sync(); const current = await f.sync();
  await assert.rejects(f.request('ready', { syncId: prior }), /Resynchronize/);
  await f.request('ready', { syncId: current }); await f.request('close');
  const count = f.responses.length; f.publish(event(3, 'assistant.delta')); await settle(); assert.equal(f.responses.length, count);
});

test('large requests require complete chunk delivery for allowOnce; deny remains safe and never broadens scope', async t => {
  const f = fixture(); t.after(f.destroy);
  const syncId = await f.sync(); await f.request('ready', { syncId });
  const approval = event(3, 'approval.requested', { approvalId: 'approval', title: 'Check this command', detail: 'x'.repeat(40_000), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  f.publish(approval); f.setPending([approval]);
  const page = await f.request('requests', { syncId });
  assert.equal(page.body.items[0].payload, null); assert.equal(page.body.items[0].reviewToken, undefined);
  const commandId = randomUUID();
  const command = { syncId, commandId, type: 'tool.approval.resolve', data: { approvalId: 'approval', turnId: 'turn', decision: 'allowOnce' } };
  await assert.rejects(f.request('command', command), /actionable/); assert.equal(f.sent.length, 0);
  await assert.rejects(f.request('event', { syncId, seq: 3, offset: 39_000 }), /beginning/);
  let offset = 0, content = '', token = '';
  for (;;) {
    const chunk = await f.request('event', { syncId, seq: 3, offset });
    const bytes = Buffer.from(chunk.body.data, 'base64'); offset += bytes.length; content += bytes.toString();
    if (chunk.body.final) { token = chunk.body.reviewToken; break; }
  }
  assert.equal(JSON.parse(content).payload.data.detail.length, 40_000);
  await f.request('command', { ...command, reviewToken: token });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].deviceId, 'mac'); assert.equal(f.sent[0].sessionId, 'session');
  assert.equal(f.sent[0].payload.decision, 'allowOnce');
  await assert.rejects(f.request('command', { ...command, reviewToken: token })); assert.equal(f.sent.length, 1);
  await f.relay.acknowledge(f.mac, { ...f.sent[0], type: 'command.ack', payload: { commandId, status: 'completed' } });
  await settle();
  assert.equal(f.responses.find(item => item.op === 'ack').body.ack.status, 'completed');
  assert.equal((await f.request('status', { commandId })).body.ack.status, 'completed');
});

test('expired or already resolved requests and invalid question answers never reach the device', async t => {
  const f = fixture(); t.after(f.destroy);
  const syncId = await f.sync(); await f.request('ready', { syncId });
  const question = event(3, 'user-input.requested', { requestId: 'question', questions: [{ id: 'q1', options: [{ label: 'yes' }, { label: 'no' }], allowsOther: false }] });
  f.setPending([question]);
  const token = (await f.request('requests', { syncId })).body.items[0].reviewToken;
  const command = { syncId, commandId: randomUUID(), reviewToken: token, type: 'tool.user-input.resolve', data: { requestId: 'question', turnId: 'turn', answers: { q1: ['not an option'] } } };
  await assert.rejects(f.request('command', command));
  command.data.answers.q1 = ['yes', 'no']; await assert.rejects(f.request('command', command));
  command.data.answers.q1 = ['yes']; f.setPending([]); await assert.rejects(f.request('command', command));
  (question.payload.data as Record<string, unknown>).expiresAt = new Date(Date.now() - 1000).toISOString();
  f.setPending([question]); await assert.rejects(f.request('command', command)); assert.equal(f.sent.length, 0);
  delete (question.payload.data as Record<string, unknown>).expiresAt;
  await f.request('command', command); assert.equal(f.sent.length, 1);
});

test('revocation during reservation prevents dispatch and read-only grants cannot write', async t => {
  const f = fixture(); t.after(f.destroy);
  const syncId = await f.sync(); await f.request('ready', { syncId });
  f.auth.permissions = ['sessions.read'];
  const command = { syncId, commandId: randomUUID(), type: 'tool.turn.start', data: { text: 'must not execute' } };
  await assert.rejects(f.request('command', command)); assert.equal(f.sent.length, 0);
  f.auth.permissions = ['sessions.read', 'turns.write'];
  const reserve = f.records.reserve.bind(f.records);
  f.records.reserve = async envelope => { const result = await reserve(envelope); f.revoke(); return result; };
  await assert.rejects(f.request('command', command)); assert.equal(f.sent.length, 0);
});

test('buffer overflow and a missing contiguous event explicitly require resynchronization', async t => {
  const f = fixture(); t.after(f.destroy);
  const syncId = await f.sync(); f.publish(event(3, 'assistant.delta', { text: 'x'.repeat(600_000) })); await settle();
  assert.ok(f.responses.some(item => item.op === 'resync'));
  await assert.rejects(f.request('ready', { syncId }));
  const next = await f.sync(); f.events.splice(0, f.events.length, event(5, 'assistant.delta'));
  await f.request('ready', { syncId: next }); await settle();
  assert.equal(f.responses.filter(item => item.op === 'resync').length, 2);
});


test('controller schema rejects broader approvals, attachment sends and unknown command fields', () => {
  const validator = new ProtocolSchemaValidator('browser', { 'controller.conversation': controllerConversationSchema });
  const validate = (payload: unknown) => validator.validate({ type: 'controller.conversation', protocolVersion: '2', deviceId: 'installation', messageId: randomUUID(), sentAt: new Date().toISOString(), payload }).ok;
  const command = { op: 'command', sessionId: 'session', syncId: randomUUID(), commandId: randomUUID(),
    type: 'tool.approval.resolve', data: { approvalId: 'approval', turnId: 'turn', decision: 'allowOnce' } };
  assert.equal(validate(command), true);
  for (const decision of ['allowSession', 'allowAlways', 'allowPolicy', 'unknown']) assert.equal(validate({ ...command, data: { ...command.data, decision } }), false);
  assert.equal(validate({ ...command, type: 'tool.turn.start', data: { text: 'hello', attachments: ['file'] } }), false);
  assert.equal(validate({ ...command, extra: 'unexpected' }), false);
  assert.equal(validate({ op: 'event', sessionId: 'session', syncId: randomUUID(), seq: 0, offset: -1 }), false);
});

test('application wiring shares command relay and receipt repository across controller and existing gateways', async () => {
  const original = process.env.DB_ENABLED; process.env.DB_ENABLED = 'false';
  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../app.module');
    const { BrowserGateway } = await import('../realtime/browser.gateway');
    const { ClientGateway } = await import('../realtime/client.gateway');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    try {
      const relay = app.get(CommandRelayService); const records = app.get(TurnCommandRepository);
      assert.equal(Reflect.get(app.get(ControllerConversationService), 'commands'), relay);
      assert.equal(Reflect.get(app.get(ControllerConversationService), 'records'), records);
      assert.equal(Reflect.get(app.get(BrowserGateway), 'commands'), relay);
      assert.equal(Reflect.get(app.get(ClientGateway), 'commands'), relay);
    } finally { await app.close(); }
  } finally { if (original === undefined) delete process.env.DB_ENABLED; else process.env.DB_ENABLED = original; }
});
