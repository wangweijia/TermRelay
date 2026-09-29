import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type WebSocket from 'ws';
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
