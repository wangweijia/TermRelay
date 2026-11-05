import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { controllerDevicesListedSchema, controllerSessionsListedSchema } from '@termrelay/contracts';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import type { DevicesService } from '../devices/devices.service';
import type { SessionsService } from '../sessions/sessions.service';
import { ControllerConnections } from './controller-connections';
import type { ControllerAuthorization, ControllerAuthService } from './controller-auth.service';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages: any[] = [];
  closeCode = 0;
  send(text: string) { this.messages.push(JSON.parse(text)); }
  close(code: number) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
  ping() {}
  terminate() { this.close(1006); }
}
const responseValidator = new ProtocolSchemaValidator('client', {
  'controller.devices.listed': controllerDevicesListedSchema,
  'controller.sessions.listed': controllerSessionsListedSchema,
});
function fixture() {
  let active = true;
  let calls = 0;
  const records = ['mac-c', 'hidden', 'mac-a', 'mac-b'].map(id => ({ id, name: id, status: 'connected', platform: 'macOS' }));
  const queries: unknown[][] = [];
  const devices = { list: async () => { calls++; return records; } };
  const sessions = { listControllerSessions: async (...args: unknown[]) => {
    queries.push(args);
    return ['a', 'b', 'c'].filter(id => !args[1] || id > String(args[1])).slice(0, Number(args[2])).map(id => ({
      id, deviceId: args[0], workspaceId: 'opaque-workspace', toolKey: 'codex', displayName: '名称 ' + id, runtimeMode: 'acp', status: 'running',
      privateField: 'must not leak',
    }));
  } };
  const auth = { isActive: async () => active };
  const connections = new ControllerConnections(auth as unknown as ControllerAuthService, devices as unknown as DevicesService, sessions as unknown as SessionsService);
  const socket = new Socket();
  const ws = socket as unknown as WebSocket;
  const authorization: ControllerAuthorization = { role: 'controller', credentialId: 'credential', installationId: 'installation', deviceIds: ['mac-a', 'mac-b', 'mac-c'], permissions: ['sessions.read'], expiresAt: null };
  connections.attach(ws, authorization);
  const query = async (type: string, payload: unknown, extra = {}) => {
    const envelope = { type, protocolVersion: '2', messageId: randomUUID(), deviceId: authorization.installationId, sentAt: new Date().toISOString(), payload, ...extra };
    await connections.message(ws, envelope);
    return { response: socket.messages.at(-1), envelope };
  };
  return { connections, socket, ws, authorization, query, devices, records, sessions, queries, calls: () => calls, revoke: () => { active = false; } };
}

test('controller lists use scoped stable pages and correlate bounded schema-valid summaries', async t => {
  const f = fixture(); t.after(() => f.connections.onModuleDestroy());
  const first = await f.query('controller.devices.list', { limit: 2 });
  assert.equal(first.response.payload.relatedMessageId, first.envelope.messageId);
  assert.equal(responseValidator.validate(first.response).ok, true);
  assert.deepEqual(first.response.payload.items.map((row: any) => row.id), ['mac-a', 'mac-b']);
  assert.equal(first.response.payload.nextCursor, 'mac-b');
  f.records[0]!.name = 'changed';
  const second = await f.query('controller.devices.list', { limit: 2, cursor: 'mac-b' });
  assert.deepEqual(second.response.payload.items.map((row: any) => row.id), ['mac-c']);
  assert.equal(second.response.payload.nextCursor, null);
  const sessions = await f.query('controller.sessions.list', { deviceId: 'mac-a', limit: 2 });
  assert.deepEqual(f.queries[0], ['mac-a', undefined, 3]);
  assert.equal(responseValidator.validate(sessions.response).ok, true);
  assert.equal(sessions.response.payload.nextCursor, 'b');
  assert.doesNotMatch(JSON.stringify(sessions.response), /privateField|must not leak/);
  const page = await f.query('controller.sessions.list', { deviceId: 'mac-a', cursor: 'b', limit: 2 });
  assert.deepEqual(page.response.payload.items.map((row: any) => row.id), ['c']);
  assert.equal(page.response.payload.nextCursor, null);
});

test('spoofed identities, ungranted devices, missing read permission and cross-role messages are rejected before querying', async t => {
  const f = fixture(); t.after(() => f.connections.onModuleDestroy());
  for (const deviceId of ['hidden', 'nonexistent']) {
    const { response } = await f.query('controller.sessions.list', { deviceId });
    assert.equal(response.payload.code, 'unknown_device');
    assert.equal(response.payload.message, 'Resource is unavailable.');
  }
  for (const extra of [{ deviceId: 'mac-a' }, { sessionId: 'guessed' }, { commandId: randomUUID() }, { seq: 0 }]) {
    assert.equal((await f.query('controller.devices.list', {}, extra)).response.payload.code, 'invalid_message');
  }
  for (const payload of [{ limit: 21 }, { limit: 0 }, { cursor: '' }, { localPath: '/secret' }]) {
    assert.equal((await f.query('controller.devices.list', payload)).response.payload.code, 'invalid_message');
  }
  assert.equal((await f.query('device.register', {})).response.payload.code, 'invalid_message');
  assert.equal((await f.query('tool.turn.start', { text: 'no write access yet' })).response.payload.code, 'invalid_message');
  f.authorization.permissions = [];
  assert.equal((await f.query('controller.devices.list', {})).response.payload.code, 'unknown_device');
  assert.equal(f.calls(), 0); assert.equal(f.queries.length, 0);
});

test('revocation during an asynchronous query suppresses its result and closes the connection', async t => {
  const f = fixture(); t.after(() => f.connections.onModuleDestroy());
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.devices.list = async () => { await waiting; return f.records; };
  const operation = f.query('controller.devices.list', {});
  await new Promise(resolve => setImmediate(resolve));
  f.revoke(); release(); await operation;
  assert.deepEqual(f.socket.messages, []);
  assert.equal(f.socket.closeCode, 4003);
});

test('slow query concurrency and slow consumers have bounded resource budgets', async t => {
  const f = fixture(); t.after(() => f.connections.onModuleDestroy());
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.devices.list = async () => { await waiting; return f.records; };
  const first = f.query('controller.devices.list', {});
  const second = f.query('controller.devices.list', {});
  await f.query('controller.devices.list', {});
  assert.equal(f.socket.closeCode, 1013);
  release(); await Promise.all([first, second]);
  assert.deepEqual(f.socket.messages, []);
  const slow = fixture(); t.after(() => slow.connections.onModuleDestroy());
  slow.socket.bufferedAmount = 256 * 1024 + 1;
  await slow.query('controller.devices.list', {});
  assert.equal(slow.socket.closeCode, 1013);
  assert.deepEqual(slow.socket.messages, []);
});
