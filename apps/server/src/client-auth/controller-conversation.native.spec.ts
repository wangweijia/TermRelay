import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionsService, SessionEventListener, SessionStateListener } from '../sessions/sessions.service';
import type { SessionEventRecord, SessionRecord } from '../sessions/session.repository';
import type { DevicesService } from '../devices/devices.service';
import type { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { ControllerConnections } from './controller-connections';
import { ControllerConversationService } from './controller-conversation.service';
import type { ControllerAuthService, ControllerAuthorization } from './controller-auth.service';
import { CommandRelayService } from '../realtime/command-relay.service';
import { TurnCommandRepository } from '../realtime/turn-command.repository';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import { controllerConversationResultSchema } from '@termrelay/contracts';

// Explicit native loopback probe; never starts a provider or sends a model request.
async function runProbe(binary: string) {
  let active = true; let eventListener: SessionEventListener = () => {}; let stateListener: SessionStateListener = () => {};
  const session = { id: 'chat-session', deviceId: 'mac', workspaceId: 'opaque', toolKey: 'codex', displayName: 'Native chat', runtimeMode: 'acp',
    status: 'running', stateVersion: 29, origin: 'local', autoApproveEnabled: false } as SessionRecord;
  const events: SessionEventRecord[] = []; let pending: SessionEventRecord[] = [];
  const make = (seq: number, kind: string, data: Record<string, unknown>): SessionEventRecord => ({ seq, type: 'tool.event', createdAt: new Date().toISOString(),
    payload: { kind, occurredAt: new Date().toISOString(), correlation: { turnId: 'turn', itemId: String(seq) }, data: { turnId: 'turn', ...data } } });
  for (let seq = 0; seq < 30; seq++) events.push(make(seq, 'user.message', { text: `history ${seq}` }));
  const append = (kind: string, data: Record<string, unknown>) => {
    const item = make(events.length, kind, data); events.push(item); session.stateVersion = item.seq;
    eventListener({ sessionId: session.id, deviceId: session.deviceId, event: item }); return item;
  };
  const human = (kind: string, data: Record<string, unknown>) => {
    const item = append(kind, { expiresAt: new Date(Date.now() + 60_000).toISOString(), ...data }); pending = [item]; return item;
  };
  const sessions = {
    findById: async (id: string) => id === session.id ? { ...session } : undefined,
    listEvents: async (_id: string, after: number, limit: number) => events.filter(item => item.seq > after).slice(0, limit),
    listEventsBefore: async (_id: string, before: number, limit: number) => events.filter(item => item.seq < before).slice(-limit),
    listControllerSessions: async () => [session],
    listHumanRequests: async (_id: string, before: number | undefined) => pending.filter(item => before === undefined || item.seq < before),
    findHumanRequest: async (_id: string, request: { id: string; turnId: string; kind: string }) => pending.find(item => item.payload.kind === request.kind
      && (item.payload.data as Record<string, unknown>).turnId === request.turnId
      && ((item.payload.data as Record<string, unknown>).approvalId ?? (item.payload.data as Record<string, unknown>).requestId) === request.id),
    markUserMessageIntent: async () => true,
    subscribe: (listener: SessionEventListener) => { eventListener = listener; return () => { eventListener = () => {}; }; },
    subscribeState: (listener: SessionStateListener) => { stateListener = listener; return () => { stateListener = () => {}; }; },
  } as unknown as SessionsService;
  const records = new TurnCommandRepository(); const executed: any[] = []; const serverErrors: unknown[] = [];
  let relay!: CommandRelayService; let connections!: ControllerConnections; let nativeSocket: WebSocket | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const later = (action: () => void, delay: number) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, delay); timers.add(timer); };
  const mac = { send: (wire: string) => {
    const command = JSON.parse(wire).data; executed.push(command);
    const ack = () => relay.acknowledge(mac, { ...command, type: 'command.ack', payload: { commandId: command.commandId, status: 'completed' } });
    if (command.type === 'tool.turn.start') {
      append('user.message', { text: command.payload.text });
      append('assistant.completed', { text: command.payload.text === 'lost ack' ? 'executed once' : 'native answer' });
      append('turn.completed', { status: 'completed' });
      if (command.payload.text === 'lost ack') {
        later(() => nativeSocket?.close(1012, 'synthetic restart'), 20);
        later(() => { void ack().catch(error => serverErrors.push(error)); }, 250); return;
      }
      later(() => human('approval.requested', { approvalId: 'small-approval', title: 'Synthetic command', detail: 'Review this harmless fixture command' }), 30);
    } else if (command.type === 'tool.approval.resolve') {
      pending = []; append('approval.resolved', { approvalId: command.payload.approvalId, decision: command.payload.decision });
      if (command.payload.approvalId === 'small-approval') later(() => human('user-input.requested', { requestId: 'question', questions: [
        { id: 'choice', header: 'Choose', question: 'Choose both options', options: [{ label: 'one', description: 'first' }, { label: 'two', description: 'second' }], allowsMultiple: true, allowsOther: false, isSecret: false },
        { id: 'free', header: 'Details', question: 'Your details', options: [], allowsOther: true, isSecret: true },
      ] }), 30);
    } else if (command.type === 'tool.user-input.resolve') {
      assert.deepEqual(command.payload.answers, { choice: ['one', 'two'], free: ['free answer'] });
      pending = []; append('user-input.resolved', { requestId: 'question' });
      later(() => human('approval.requested', { approvalId: 'large-approval', title: 'Large request', detail: '大'.repeat(20_000) }), 30);
    }
    void ack().catch(error => serverErrors.push(error));
  } } as unknown as WebSocket;
  const registry = { getClient: (id: string) => id === 'mac' ? mac : undefined, isRegisteredClient: (socket: WebSocket) => socket === mac } as unknown as DeviceConnectionRegistry;
  relay = new CommandRelayService(registry, sessions, undefined, records);
  const conversations = new ControllerConversationService(sessions, relay, records); conversations.onModuleInit();
  connections = new ControllerConnections({ isActive: async () => active } as unknown as ControllerAuthService,
    { list: async () => [{ id: 'mac', name: 'Mac', status: 'connected', platform: 'macOS' }] } as unknown as DevicesService, sessions, conversations);
  const authorization: ControllerAuthorization = { role: 'controller', credentialId: 'native', installationId: 'native-installation', deviceIds: ['mac'],
    permissions: ['sessions.read', 'turns.write', 'approvals.resolve', 'user-input.resolve'], expiresAt: null };
  const responseValidator = new ProtocolSchemaValidator('client', { 'controller.conversation.result': controllerConversationResultSchema });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(wss, 'listening');
  const address = wss.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  wss.on('connection', socket => {
    nativeSocket = socket;
    const send = socket.send.bind(socket);
    socket.send = ((wire: string, ...args: any[]) => {
      const frame = JSON.parse(String(wire));
      if (frame.type === 'controller.conversation.result') {
        const checked = responseValidator.validate(frame);
        if (!checked.ok) serverErrors.push(new Error(JSON.stringify(checked)));
      }
      return send(wire, ...args);
    }) as typeof socket.send;
    connections.attach(socket, authorization); void connections.connected(socket);
    socket.on('message', wire => { void connections.message(socket, JSON.parse(String(wire)).data).catch(error => serverErrors.push(error)); });
  });
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-conversation-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeFile(join(directory, 'authorization.json'), JSON.stringify({ version: 1, installationId: authorization.installationId, origin,
      credential: 'tr_controller_10000000-0000-4000-8000-000000000001.' + 'x'.repeat(43) }), { mode: 0o600 });
    child = spawn(binary, [origin, directory], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
    const completion = once(child, 'exit'); let stdout = '', stderr = '';
    child.stdout?.on('data', value => {
      stdout += String(value);
      if (stdout.includes('CHAT_RECOVERED')) { active = false; connections.revoke('native'); }
    });
    child.stderr?.on('data', value => { stderr += String(value); });
    assert.equal((await completion)[0], 0, stderr + '\n' + stdout);
    assert.match(stdout, /CHAT_INTERACTION_OK/); assert.match(stdout, /CHAT_RECOVERED/); assert.match(stdout, /CHAT_REVOKED/);
    assert.equal(executed.filter(item => item.type === 'tool.turn.start' && item.payload.text === 'lost ack').length, 1);
    assert.equal(executed.length, 5); assert.deepEqual(serverErrors, []);
    const stored = JSON.parse(await readFile(join(directory, 'authorization.json'), 'utf8'));
    assert.equal(stored.credential, ''); assert.deepEqual(stored.pendingCommands, []);
    assert.doesNotMatch(JSON.stringify(stored), /hello from native|free answer|native answer/);
    stateListener({ ...session, status: 'finished' });
  } finally {
    if (child && child.exitCode === null) child.kill();
    for (const timer of timers) clearTimeout(timer);
    connections.onModuleDestroy(); conversations.onModuleDestroy(); relay.onModuleDestroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [name, binary] of [
  ['native conversation protocol', process.env.TERMRELAY_CONVERSATION_PROBE],
  ['headless LVGL conversation controls', process.env.TERMRELAY_CONVERSATION_UI_PROBE],
] as const) test(`${name}: history, streaming, approvals, questions, lost ACK and revocation`, { skip: !binary, timeout: 70_000 }, async () => {
  await runProbe(binary!);
});
