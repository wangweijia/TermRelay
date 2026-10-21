import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { CommandAckPayload, Envelope, SessionStartPayload } from '@termrelay/contracts';
import { SessionStartService } from './session-start.service';
import { SessionStartRepository } from './session-start.repository';
import { SessionStartEntity, type SessionStartStatus } from './session-start.entity';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceEntity } from './workspace.entity';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { SessionsService } from './sessions.service';
import type { SessionRecord } from './session.repository';
import { SessionStartController } from './session-start.controller';
import { CommandRelayService } from '../realtime/command-relay.service';

class MemoryStarts extends SessionStartRepository {
  readonly rows = new Map<string, SessionStartEntity>();
  override async find(id: string) { return this.rows.get(id) ?? null; }
  override async reserve(id: string, deviceId: string, request: SessionStartPayload) {
    if (this.rows.has(id)) return false;
    this.rows.set(id, Object.assign(new SessionStartEntity(), {
      id, deviceId, request, status: 'pending', message: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    return true;
  }
  override async update(id: string, status: SessionStartStatus, message: string | null) {
    const row = this.rows.get(id);
    if (row && ['pending', 'accepted', 'unknown'].includes(row.status)) Object.assign(row, { status, message, updatedAt: new Date() });
  }
  override async markUnknown(deviceId?: string) {
    for (const row of this.rows.values()) if ((!deviceId || row.deviceId === deviceId) && ['pending', 'accepted'].includes(row.status)) {
      await this.update(row.id, 'unknown', 'Disconnected; result unknown');
    }
  }
  override async countPending(deviceId: string) {
    return [...this.rows.values()].filter(row => row.deviceId === deviceId && ['pending', 'accepted'].includes(row.status)).length;
  }
}

class MemoryWorkspaces extends WorkspaceRepository {
  override get enabled() { return true; }
  readonly row = Object.assign(new WorkspaceEntity(), {
    id: 'workspace-1', deviceId: 'device-1', displayName: 'Project', available: true, remoteStartAllowed: true,
    launchOptions: [{ toolKey: 'codex', runtimeMode: 'acp' }, { toolKey: 'shell', runtimeMode: 'pty' }],
  });
  override async findById(id: string) { return id === this.row.id ? this.row : null; }
  override async listRemote() { return this.row.remoteStartAllowed && this.row.available ? [this.row] : []; }
}

function setup() {
  const store = new MemoryStarts(), workspaces = new MemoryWorkspaces(), registry = new DeviceConnectionRegistry();
  const records = new Map<string, SessionRecord>();
  const sessions = {
    findById: async (id: string) => records.get(id), list: async () => [...records.values()],
  } as SessionsService;
  const sent: Envelope<SessionStartPayload>[] = [];
  const socket = {
    send: (raw: string, callback?: (error?: Error) => void) => {
      sent.push((JSON.parse(raw) as { data: Envelope<SessionStartPayload> }).data);
      callback?.();
    }, close: () => undefined,
  } as WebSocket;
  registry.connect(socket);
  registry.register(socket, 'device-1', { name: 'Linux', appVersion: '0.1', platform: 'linux', tools: ['shell', 'codex'] });
  const service = new SessionStartService(store, workspaces, registry, sessions);
  const body = {
    requestId: randomUUID(), deviceId: 'device-1', workspaceId: 'workspace-1',
    toolKey: 'codex', runtimeMode: 'acp', displayName: 'Remote',
  };
  const acknowledge = (status: CommandAckPayload['status'], overrides: Partial<Envelope<CommandAckPayload>> = {}) =>
    service.acknowledge(socket, {
      type: 'command.ack', protocolVersion: '2', messageId: randomUUID(), deviceId: body.deviceId,
      sessionId: body.requestId, commandId: body.requestId, sentAt: new Date().toISOString(),
      payload: { commandId: body.requestId, status, ...(status === 'rejected' ? { message: 'Provider unavailable' } : {}) }, ...overrides,
    });
  const register = () => records.set(body.requestId, {
    id: body.requestId, deviceId: body.deviceId, workspaceId: body.workspaceId, toolKey: body.toolKey,
    displayName: body.displayName, runtimeMode: 'acp', status: 'running', stateVersion: 0, autoApproveEnabled: false,
    origin: 'local', startedAt: new Date().toISOString(), finishedAt: null, createdAt: '', updatedAt: '',
  });
  return { store, workspaces, registry, sent, service, body, acknowledge, register, records, socket, sessions };
}

test('remote start reserves before delivery, binds request/session ID and deduplicates simultaneous submissions', async () => {
  const x = setup();
  const controller = new SessionStartController(x.service);
  const [a, b] = await Promise.all([controller.create(x.body), controller.create({ ...x.body, requestId: x.body.requestId.toUpperCase() })]);
  assert.equal(a.id, b.id);
  assert.equal(x.store.rows.size, 1);
  assert.equal(x.sent.length, 1);
  assert.equal(x.sent[0]?.type, 'session.start');
  assert.equal(x.sent[0]?.sessionId, x.body.requestId);
  assert.equal(x.sent[0]?.commandId, x.body.requestId);
  assert.equal(JSON.stringify(await controller.targets()).includes('path'), false);
  await x.acknowledge('accepted');
  assert.equal((await controller.get(x.body.requestId)).status, 'accepted');
  x.register();
  await x.acknowledge('completed');
  assert.equal((await controller.get(x.body.requestId)).status, 'completed');
  await x.acknowledge('rejected');
  assert.equal((await controller.get(x.body.requestId)).status, 'completed');
  await assert.rejects(controller.create({ ...x.body, toolKey: 'shell', runtimeMode: 'pty', rows: 24, columns: 80 }), /already bound/);
  assert.equal(x.sent.length, 1);
});

test('rejects untrusted paths, initial prompts, wrong ownership/mode, stale authorization and offline devices', async () => {
  const x = setup();
  for (const change of [{ path: '/tmp' }, { initialPrompt: 'run something' }, { runtimeMode: 'pty' }, { rows: 0 }, { deviceId: 'another' }]) {
    await assert.rejects(x.service.create({ ...x.body, ...change }));
  }
  x.workspaces.row.remoteStartAllowed = false;
  await assert.rejects(x.service.create(x.body), /not authorized/);
  assert.deepEqual(await x.service.targets(), []);
  x.workspaces.row.remoteStartAllowed = true;
  x.registry.disconnect(x.socket);
  assert.deepEqual(await x.service.targets(), []);
  await assert.rejects(x.service.create(x.body), /offline/);
  assert.equal(x.sent.length, 0);
});

test('timeout and Server restart retain unknown result without redispatch; late session registration reconciles', async () => {
  const x = setup();
  await x.service.create(x.body);
  x.store.rows.get(x.body.requestId)!.createdAt = new Date(Date.now() - 61_000);
  assert.equal((await x.service.get(x.body.requestId)).status, 'unknown');
  await x.service.onModuleInit();
  try {
    assert.equal((await x.service.create(x.body)).status, 'unknown');
    assert.equal(x.sent.length, 1);
    x.register();
    assert.equal((await x.service.get(x.body.requestId)).status, 'completed');
  } finally { x.service.onModuleDestroy(); }
});

test('provider failures are terminal and completed ACK alone cannot invent a session', async () => {
  const x = setup();
  await x.service.create(x.body);
  await x.acknowledge('completed');
  assert.equal((await x.service.get(x.body.requestId)).status, 'unknown');
  await x.acknowledge('rejected');
  assert.equal((await x.service.get(x.body.requestId)).status, 'failed');
  assert.match((await x.service.get(x.body.requestId)).message!, /Provider unavailable/);
  await x.service.create(x.body);
  assert.equal(x.sent.length, 1);
});

test('acknowledgements are device-bound and creation is bounded to eight pending/active sessions', async () => {
  const x = setup();
  await x.service.create(x.body);
  await assert.rejects(x.acknowledge('accepted', { deviceId: 'another' }), /another device/);
  for (let i = 1; i < 8; i++) await x.service.create({ ...x.body, requestId: randomUUID() });
  await assert.rejects(x.service.create({ ...x.body, requestId: randomUUID() }), /eight-session/);
  assert.equal(x.sent.length, 8);
  await x.service.disconnected(x.body.deviceId);
  assert.equal((await x.service.get(x.body.requestId)).status, 'unknown');
});

test('ordinary commands cannot reuse the creation ID and accidentally consume its acknowledgement', async () => {
  const x = setup();
  await x.service.create(x.body);
  x.register();
  const relay = new CommandRelayService(x.registry, x.sessions, x.service);
  const routed = await relay.route(x.socket, {
    type: 'tool.turn.start', protocolVersion: '2', messageId: randomUUID(), deviceId: x.body.deviceId,
    sessionId: x.body.requestId, commandId: x.body.requestId, sentAt: new Date().toISOString(),
    payload: { text: 'must not execute with creation command ID' },
  });
  assert.equal(routed.ok, false);
  if (!routed.ok) assert.equal(routed.code, 'conflict');
  assert.equal(x.sent.length, 1);
  relay.onModuleDestroy();
});
