import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AttachmentResultPayload, Envelope } from '@termrelay/contracts';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { AttachmentsService } from './attachments.service';
import type { SessionsService } from './sessions.service';

function setup() {
  const registry = new DeviceConnectionRegistry();
  const sent: { data: { payload: { requestId: string; workspaceId: string } } }[] = [];
  const client = { send: (message: string) => { sent.push(JSON.parse(message)); } } as unknown as WebSocket;
  registry.connect(client);
  registry.register(client, 'mac', { name: 'Mac', appVersion: '1', platform: 'macOS', chatAttachments: true, tools: ['codex'] });
  const sessions = { findById: async (id: string) => id === 'chat'
    ? { id, deviceId: 'mac', workspaceId: 'workspace', runtimeMode: 'acp', status: 'running' } : null } as SessionsService;
  const service = new AttachmentsService(sessions, registry);
  return { service, sent, client, registry };
}
function reply(requestId: string): Envelope<AttachmentResultPayload> {
  return { type: 'attachment.result', protocolVersion: '2', deviceId: 'mac', sessionId: 'chat', messageId: randomUUID(), sentAt: new Date().toISOString(), payload: { requestId, status: 'ok' } };
}

test('attachment bytes are routed only to the owning connection and matched by session', async () => {
  const { service, sent, client } = setup();
  const pending = service.transfer('chat', { operation: 'read', attachmentId: randomUUID(), offset: 0 });
  await new Promise(resolve => setImmediate(resolve));
  const request = sent[0]!.data.payload;
  assert.equal(request.workspaceId, 'workspace');
  assert.equal(service.accept({} as WebSocket, reply(request.requestId)), false);
  assert.equal(service.accept(client, { ...reply(request.requestId), sessionId: 'other' }), false);
  assert.equal(service.accept(client, reply(request.requestId)), true);
  assert.equal((await pending).status, 'ok');
  assert.equal(service.accept(client, reply(request.requestId)), false);
});

test('rejects oversized chunks, forged scope, invalid metadata, missing sessions and offline devices', async () => {
  const { service, registry, client } = setup();
  const id = randomUUID();
  const body = { operation: 'upload', attachmentId: id, offset: 0, data: 'eA==', final: true,
    attachment: { id, name: 'notes.txt', mimeType: 'text/plain', size: 1 } };
  await assert.rejects(service.transfer('chat', { ...body, workspaceId: 'forged' }), { status: 400 });
  await assert.rejects(service.transfer('chat', { ...body, data: 'A'.repeat(262148) }), { status: 400 });
  await assert.rejects(service.transfer('chat', { ...body, attachment: { ...body.attachment, id: randomUUID() } }), { status: 400 });
  await assert.rejects(service.transfer('missing', body), { status: 404 });
  registry.disconnect(client);
  await assert.rejects(service.transfer('chat', body), { status: 503 });
});

test('shutdown releases all waiting uploads and rejects stale responses', async () => {
  const { service, sent, client } = setup();
  const pending = service.transfer('chat', { operation: 'read', attachmentId: randomUUID(), offset: 0 });
  await new Promise(resolve => setImmediate(resolve));
  service.onModuleDestroy();
  await assert.rejects(pending, { status: 503 });
  assert.equal(service.accept(client, reply(sent[0]!.data.payload.requestId)), false);
});

test('capability lookup disables upload for devices that did not opt in', async () => {
  const { service, registry, client } = setup();
  assert.deepEqual(await service.capabilities('chat'), { supported: true });
  registry.register(client, 'mac', { name: 'Old Mac', appVersion: '1', platform: 'macOS', tools: ['codex'] });
  assert.deepEqual(await service.capabilities('chat'), { supported: false });
  await assert.rejects(service.transfer('chat', { operation: 'read', attachmentId: randomUUID(), offset: 0 }), { status: 400 });
});

test('session cleanup is device scoped and cannot be invoked as an upload request', async () => {
  const { service, sent } = setup();
  await assert.rejects(service.transfer('chat', { operation: 'purge', attachmentId: randomUUID(), offset: 0 }), { status: 400 });
  service.cleanup({ id: 'chat', deviceId: 'mac', workspaceId: 'workspace' });
  assert.equal(sent[0]?.data.payload.workspaceId, 'workspace');
  assert.equal((sent[0]?.data.payload as { operation?: string }).operation, 'purge');
});
