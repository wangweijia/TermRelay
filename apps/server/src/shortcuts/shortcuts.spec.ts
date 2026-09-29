import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { ClientGateway } from '../realtime/client.gateway';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { ProtocolValidator } from '../realtime/protocol-validator';
import type { SessionsService } from '../sessions/sessions.service';
import { ShortcutsController } from './shortcuts.controller';
import { ShortcutsRepository, UNKNOWN_EXECUTION_RESULT } from './shortcuts.repository';
import { ShortcutsService } from './shortcuts.service';

const shortcutId = randomUUID();
const otherId = randomUUID();
const entry = {
  id: shortcutId, revision: 1, name: 'Build', description: 'Build project',
  workspaceId: 'opaque-1', proxyMode: 'inherit' as const, requiresConfirmation: true,
};

class FakeSocket {
  readyState = 1;
  messages: Array<{ event: string; data: { type: string; payload: Record<string, unknown> } }> = [];
  send(message: string, callback?: (error?: Error) => void): void {
    this.messages.push(JSON.parse(message));
    callback?.();
  }
  close(): void { this.readyState = 3; }
  asSocket(): WebSocket { return this as unknown as WebSocket; }
}

function setup() {
  const registry = new DeviceConnectionRegistry();
  const store = new ShortcutsRepository();
  const service = new ShortcutsService(store, registry);
  service.onModuleInit();
  const controller = new ShortcutsController(service);
  const gateway = new ClientGateway(new ProtocolValidator(), registry, {} as SessionsService,
    undefined, undefined, service);
  const socket = new FakeSocket();
  const client = socket.asSocket();
  gateway.handleConnection(client);
  return { registry, store, service, controller, gateway, socket, client };
}

function message(deviceId: string, type: string, payload: object) {
  return { type, protocolVersion: '2', messageId: randomUUID(), deviceId,
    sentAt: new Date().toISOString(), payload };
}

async function register(fixture: ReturnType<typeof setup>, deviceId = 'mac-a') {
  await fixture.gateway.handleMessage(fixture.client, message(deviceId, 'device.register', {
    name: 'Mac', appVersion: '1.0', platform: 'macOS', tools: [],
  }));
}

test('registered device publishes a full metadata-only catalog; invalid and foreign catalogs are rejected', async () => {
  const f = setup();
  const premature = new FakeSocket();
  f.gateway.handleConnection(premature.asSocket());
  await f.gateway.handleMessage(premature.asSocket(), message('mac-a', 'shortcut.catalog', { shortcuts: [entry] }));
  assert.equal(premature.messages.at(-1)?.data.payload.code, 'unknown_device');
  await register(f);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.catalog', { shortcuts: [entry] }));
  assert.deepEqual(await f.controller.list(), [{ ...entry, deviceId: 'mac-a', online: true }]);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.catalog', { shortcuts: [entry, entry] }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'invalid_message');
  const foreign = new FakeSocket();
  f.gateway.handleConnection(foreign.asSocket());
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'device.register', {
    name: 'Other Mac', appVersion: '1.0', platform: 'macOS', tools: [],
  }));
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'shortcut.catalog', { shortcuts: [entry] }));
  assert.equal(foreign.messages.at(-1)?.data.payload.code, 'conflict');
  assert.deepEqual(await f.controller.list(), [{ ...entry, deviceId: 'mac-a', online: true }]);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.catalog', { shortcuts: [] }));
  assert.deepEqual(await f.controller.list(), []);
  f.service.onModuleDestroy();
});

test('start dispatches revision once, enforces run ID idempotency and one active run per shortcut', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  const started = await f.controller.start(shortcutId, { runId });
  assert.equal(started.status, 'queued');
  assert.deepEqual(f.socket.messages.at(-1)?.data.payload, {
    runId, shortcutId, revision: 1,
  });
  assert.deepEqual(await f.controller.start(shortcutId, { runId }), started);
  assert.equal(f.socket.messages.filter((m) => m.data.type === 'shortcut.run.start').length, 1);
  await assert.rejects(f.controller.start(shortcutId, { runId: randomUUID() }), { status: 409 });
  await f.service.catalog('mac-a', { shortcuts: [{ ...entry, id: otherId }] });
  await assert.rejects(f.controller.start(otherId, { runId }), { status: 409 });
  f.service.onModuleDestroy();
});

test('run updates require owning registered connection, bounded snapshot and non-terminal state', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  const foreign = new FakeSocket();
  f.gateway.handleConnection(foreign.asSocket());
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'device.register', {
    name: 'Other Mac', appVersion: '1.0', platform: 'macOS', tools: [],
  }));
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'shortcut.run.update', { runId, status: 'running' }));
  assert.equal(foreign.messages.at(-1)?.data.payload.code, 'conflict');
  const unregistered = new FakeSocket();
  f.gateway.handleConnection(unregistered.asSocket());
  await f.gateway.handleMessage(unregistered.asSocket(), message('mac-a', 'shortcut.run.update', { runId, status: 'running' }));
  assert.equal(unregistered.messages.at(-1)?.data.payload.code, 'unknown_device');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'running', output: 'one',
  }));
  assert.equal((await f.controller.getRun(runId)).output, 'one');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'running', output: 'two',
  }));
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'succeeded', exitCode: 0,
  }));
  assert.equal((await f.controller.getRun(runId)).status, 'succeeded');
  assert.equal((await f.controller.getRun(runId)).output, 'two');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'running', output: 'delayed running snapshot',
  }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'conflict');
  assert.equal((await f.controller.getRun(runId)).output, 'two');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', { runId, status: 'failed' }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'conflict');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'failed', output: 'x'.repeat(32769),
  }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'invalid_message');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId: randomUUID(), status: 'succeeded',
  }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'conflict');
  f.service.onModuleDestroy();
});

test('cancel is a request, not terminal; offline and disconnect fail active runs without retry', async () => {
  const f = setup();
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  await assert.rejects(f.controller.start(shortcutId, { runId: randomUUID() }), { status: 503 });
  await register(f);
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  const cancelled = await f.controller.cancel(runId);
  assert.equal(cancelled.status, 'queued');
  assert.equal(f.socket.messages.at(-1)?.data.type, 'shortcut.run.cancel');
  f.gateway.handleDisconnect(f.client);
  assert.equal((await f.controller.getRun(runId)).status, 'failed');
  assert.equal((await f.controller.getRun(runId)).output, UNKNOWN_EXECUTION_RESULT);
  assert.equal((await f.controller.list())[0]?.online, false);
  assert.equal((await f.controller.start(shortcutId, { runId })).status, 'failed');
  assert.equal(f.socket.messages.filter((m) => m.data.type === 'shortcut.run.start').length, 1);
  f.service.onModuleDestroy();
});

test('Mac cancellation confirmation is terminal, frees shortcut slot, and never accepts later updates', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  await f.controller.cancel(runId);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'cancelled', output: 'Stopped by user',
  }));
  assert.equal((await f.controller.getRun(runId)).status, 'cancelled');
  assert.equal((await f.controller.cancel(runId)).status, 'cancelled');
  assert.equal((await f.controller.start(shortcutId, { runId: randomUUID() })).status, 'queued');
  f.service.onModuleDestroy();
});

test('coalesces burst snapshots and rejects a delayed running update after immediate queued failure', async () => {
  class CountingStore extends ShortcutsRepository {
    writes = 0;
    override async updateRun(deviceId: string, payload: Parameters<ShortcutsRepository['updateRun']>[1]) {
      this.writes++;
      return super.updateRun(deviceId, payload);
    }
  }
  const registry = new DeviceConnectionRegistry();
  const store = new CountingStore();
  const service = new ShortcutsService(store, registry);
  await service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await store.createRun(runId, (await store.findShortcut(shortcutId))!);
  assert.equal(await service.update('mac-a', { runId, status: 'failed', output: 'Process could not start' }), true);
  assert.equal(await service.update('mac-a', { runId, status: 'running', output: 'stale' }), false);
  assert.equal((await store.findRun(runId))?.output, 'Process could not start');
  const nextId = randomUUID();
  await store.createRun(nextId, (await store.findShortcut(shortcutId))!);
  await service.update('mac-a', { runId: nextId, status: 'running', output: 'first' });
  for (let i = 0; i < 25; i++) {
    assert.equal(await service.update('mac-a', { runId: nextId, status: 'running', output: String(i) }), true);
  }
  assert.equal(await service.update('mac-a', { runId: nextId, status: 'succeeded' }), true);
  assert.equal((await store.findRun(nextId))?.output, '24');
  assert.equal(store.writes, 4);
  assert.equal(await service.update('mac-a', { runId: nextId, status: 'running', output: 'late' }), false);
  assert.equal((await store.findRun(nextId))?.status, 'succeeded');
  service.onModuleDestroy();
});

test('accepts success directly from queued and prunes only old terminal runs', async () => {
  const store = new ShortcutsRepository();
  await store.replaceCatalog('mac-a', [entry]);
  const shortcut = (await store.findShortcut(shortcutId))!;
  const succeeded = randomUUID();
  const active = randomUUID();
  await store.createRun(succeeded, shortcut);
  assert.equal((await store.updateRun('mac-a', {
    runId: succeeded, status: 'succeeded', exitCode: 0, output: 'Done',
  }))?.status, 'succeeded');
  assert.equal(await store.updateRun('mac-a', {
    runId: succeeded, status: 'running', output: 'stale',
  }), undefined);
  await store.createRun(active, shortcut);
  await store.pruneFinishedRuns(new Date(Date.now() + 31 * 24 * 60 * 60 * 1_000));
  assert.equal(await store.findRun(succeeded), undefined);
  assert.equal((await store.findRun(active))?.status, 'queued');
});

test('client gateway accepts a quick success without a preceding running update', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', {
    runId, status: 'succeeded', exitCode: 0, output: 'Quick result',
  }));
  assert.equal((await f.controller.getRun(runId)).status, 'succeeded');
  assert.equal((await f.controller.getRun(runId)).output, 'Quick result');
  f.service.onModuleDestroy();
});

test('lists recent persisted run records across shortcuts with validated limits', async () => {
  const f = setup();
  await f.store.replaceCatalog('mac-a', [entry, { ...entry, id: otherId, name: 'Other' }]);
  const shortcuts = [
    (await f.store.findShortcut(shortcutId))!,
    (await f.store.findShortcut(otherId))!,
  ];
  const records = [];
  for (let index = 0; index < 22; index++) {
    const runId = randomUUID();
    await f.store.createRun(runId, shortcuts[index % 2]!);
    await f.store.updateRun('mac-a', { runId, status: 'succeeded', output: `result-${index}` });
    records.push((await f.controller.getRun(runId)));
  }
  const expected = records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id));
  assert.deepEqual(await f.controller.listRuns(), expected.slice(0, 20));
  assert.deepEqual(await f.controller.listRuns('1'), expected.slice(0, 1));
  assert.deepEqual(await f.controller.listRuns('100'), expected);
  assert.deepEqual(await f.controller.getRun(expected[0]!.id), expected[0]);
  for (const invalid of ['0', '101', '-1', '1.5', ' 2', '2 ', 'abc', '9007199254740991']) {
    await assert.rejects(async () => f.controller.listRuns(invalid), { status: 400 });
  }
  f.service.onModuleDestroy();
});

test('catalog and update schemas reject oversized or unexpected fields', () => {
  const validator = new ProtocolValidator();
  assert.equal(validator.validate(message('mac-a', 'shortcut.catalog', {
    shortcuts: Array.from({ length: 101 }, (_, index) => ({ ...entry, id: randomUUID(), revision: index + 1 })),
  })).ok, false);
  assert.equal(validator.validate(message('mac-a', 'shortcut.catalog', {
    shortcuts: [{ ...entry, command: 'unsafe' }],
  })).ok, false);
  assert.equal(validator.validate(message('mac-a', 'shortcut.run.update', {
    runId: randomUUID(), status: 'failed', output: 'x'.repeat(32768),
  })).ok, true);
  assert.equal(validator.validate(message('mac-a', 'shortcut.run.update', {
    runId: randomUUID(), status: 'queued',
  })).ok, false);
});

test('input validates exact HTTP body, active run and online device', async () => {
  const f = setup();
  const runId = randomUUID();
  for (const body of [
    {}, { commandId: randomUUID(), answer: 'Y' }, { commandId: 'bad', answer: 'y' },
    { commandId: randomUUID(), answer: 'yes', extra: true }, null, [],
  ]) {
    await assert.rejects(async () => f.controller.input(runId, body), { status: 400 });
  }
  await assert.rejects(f.controller.input(runId, { commandId: randomUUID(), answer: 'n' }), { status: 404 });
  await f.store.replaceCatalog('mac-a', [entry]);
  await f.store.createRun(runId, (await f.store.findShortcut(shortcutId))!);
  await assert.rejects(f.controller.input(runId, { commandId: randomUUID(), answer: 'n' }), { status: 409 });
  await f.store.updateRun('mac-a', { runId, status: 'running' });
  await assert.rejects(f.controller.input(runId, { commandId: randomUUID(), answer: 'n' }), { status: 503 });
  f.service.onModuleDestroy();
});

test('shortcut input relays once, matches owning device/run, caches ACK and rejects conflicting IDs', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', { runId, status: 'running' }));
  const commandId = randomUUID();
  const first = f.controller.input(runId, { commandId, answer: 'yes' });
  const repeated = f.controller.input(runId, { commandId, answer: 'yes' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.socket.messages.at(-1)?.data.payload, { runId, commandId, answer: 'yes' });
  assert.equal(f.socket.messages.at(-1)?.data.type, 'shortcut.run.input');
  assert.equal(f.socket.messages.filter((m) => m.data.type === 'shortcut.run.input').length, 1);
  await assert.rejects(f.controller.input(runId, { commandId, answer: 'no' }), { status: 409 });
  await assert.rejects(f.controller.input(randomUUID(), { commandId, answer: 'yes' }), { status: 409 });
  const foreign = new FakeSocket();
  f.gateway.handleConnection(foreign.asSocket());
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'device.register', {
    name: 'Mac B', appVersion: '1', platform: 'macOS', tools: [],
  }));
  const ack = { runId, commandId, status: 'accepted' };
  await f.gateway.handleMessage(foreign.asSocket(), message('mac-b', 'shortcut.run.input.ack', ack));
  assert.equal(foreign.messages.at(-1)?.data.payload.code, 'conflict');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.input.ack', { ...ack, runId: randomUUID() }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'conflict');
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.input.ack', ack));
  assert.deepEqual(await first, { accepted: true });
  assert.deepEqual(await repeated, { accepted: true });
  assert.deepEqual(await f.controller.input(runId, { commandId, answer: 'yes' }), { accepted: true });
  assert.equal(f.socket.messages.filter((m) => m.data.type === 'shortcut.run.input').length, 1);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.input.ack', ack));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'conflict');
  f.service.onModuleDestroy();
});

test('input ACK schema excludes envelope context and rejects invalid statuses and fields', () => {
  const validator = new ProtocolValidator();
  const payload = { runId: randomUUID(), commandId: randomUUID(), status: 'rejected', message: 'not ready' };
  assert.equal(validator.validate(message('mac-a', 'shortcut.run.input.ack', payload)).ok, true);
  for (const context of [{ sessionId: 'session' }, { seq: 1 }, { commandId: payload.commandId }]) {
    assert.equal(validator.validate({ ...message('mac-a', 'shortcut.run.input.ack', payload), ...context }).ok, false);
  }
  for (const invalid of [
    { ...payload, status: 'completed' }, { ...payload, unexpected: true },
    { ...payload, commandId: 'bad' }, { ...payload, message: 'x'.repeat(2049) },
  ]) {
    assert.equal(validator.validate(message('mac-a', 'shortcut.run.input.ack', invalid)).ok, false);
  }
});

test('rejected ACK, disconnect and timeout return explicit cached outcomes; stale sockets cannot ACK', async () => {
  const f = setup();
  await register(f);
  await f.service.catalog('mac-a', { shortcuts: [entry] });
  const runId = randomUUID();
  await f.controller.start(shortcutId, { runId });
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.update', { runId, status: 'running' }));
  const rejectedId = randomUUID();
  const rejected = f.controller.input(runId, { commandId: rejectedId, answer: 'n' });
  await new Promise((resolve) => setImmediate(resolve));
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.input.ack', {
    runId, commandId: rejectedId, status: 'rejected', message: 'No prompt',
  }));
  await assert.rejects(rejected, { status: 409, message: 'No prompt' });
  await assert.rejects(f.controller.input(runId, { commandId: rejectedId, answer: 'n' }), { status: 409, message: 'No prompt' });
  const disconnectedId = randomUUID();
  const disconnected = f.controller.input(runId, { commandId: disconnectedId, answer: 'y' });
  await new Promise((resolve) => setImmediate(resolve));
  f.gateway.handleDisconnect(f.client);
  await assert.rejects(disconnected, /delivery is unknown/u);
  await assert.rejects(f.controller.input(runId, { commandId: disconnectedId, answer: 'y' }), /delivery is unknown/u);
  await f.gateway.handleMessage(f.client, message('mac-a', 'shortcut.run.input.ack', {
    runId, commandId: disconnectedId, status: 'accepted',
  }));
  assert.equal(f.socket.messages.at(-1)?.data.payload.code, 'unknown_device');
  f.service.onModuleDestroy();

  const timed = setup();
  await register(timed);
  await timed.service.catalog('mac-a', { shortcuts: [entry] });
  const nextRun = randomUUID();
  await timed.controller.start(shortcutId, { runId: nextRun });
  await timed.gateway.handleMessage(timed.client, message('mac-a', 'shortcut.run.update', { runId: nextRun, status: 'running' }));
  const timeoutId = randomUUID();
  const timeout = timed.controller.input(nextRun, { commandId: timeoutId, answer: 'no' });
  await assert.rejects(timeout, { status: 504 });
  await assert.rejects(timed.controller.input(nextRun, { commandId: timeoutId, answer: 'no' }), { status: 504 });
  assert.equal(timed.socket.messages.filter((m) => m.data.type === 'shortcut.run.input').length, 1);
  await timed.gateway.handleMessage(timed.client, message('mac-a', 'shortcut.run.input.ack', {
    runId: nextRun, commandId: timeoutId, status: 'accepted',
  }));
  assert.deepEqual(await timed.controller.input(nextRun, { commandId: timeoutId, answer: 'no' }), { accepted: true });
  assert.equal(timed.socket.messages.filter((m) => m.data.type === 'shortcut.run.input').length, 1);
  timed.service.onModuleDestroy();
});

test('real WebSocket gateway forwards input and resolves HTTP only after device ACK', async () => {
  const registry = new DeviceConnectionRegistry();
  const service = new ShortcutsService(new ShortcutsRepository(), registry);
  service.onModuleInit();
  const controller = new ShortcutsController(service);
  const gateway = new ClientGateway(new ProtocolValidator(), registry, {} as SessionsService,
    undefined, undefined, service);
  const server = new WebSocketServer({ port: 0 });
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const socket = await new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    gateway.handleConnection(socket);
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { event: string; data: unknown };
      void gateway.handleMessage(socket, frame.data);
    });
    await new Promise<void>((resolve) => client.once('open', resolve));
    client.send(JSON.stringify({ event: 'message', data: message('mac-a', 'device.register', {
      name: 'Mac', appVersion: '1', platform: 'macOS', tools: [],
    }) }));
    await new Promise<void>((resolve) => client.once('message', () => resolve()));
    await service.catalog('mac-a', { shortcuts: [entry] });
    const runId = randomUUID();
    await controller.start(shortcutId, { runId });
    await new Promise<void>((resolve) => client.once('message', () => resolve()));
    client.send(JSON.stringify({ event: 'message', data: message('mac-a', 'shortcut.run.update', { runId, status: 'running' }) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const commandId = randomUUID();
    const inputFrame = new Promise<{ event: string; data: { type: string; payload: Record<string, string> } }>((resolve) => {
      client.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    const result = controller.input(runId, { commandId, answer: 'y' });
    const frame = await inputFrame;
    assert.equal(frame.event, 'message');
    assert.equal(frame.data.type, 'shortcut.run.input');
    assert.deepEqual(frame.data.payload, { runId, commandId, answer: 'y' });
    client.send(JSON.stringify({ event: 'message', data: message('mac-a', 'shortcut.run.input.ack', {
      runId, commandId, status: 'accepted',
    }) }));
    assert.deepEqual(await result, { accepted: true });
    gateway.handleDisconnect(socket);
    client.close();
  } finally {
    service.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
