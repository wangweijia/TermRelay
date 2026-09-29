import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Envelope, FilePreviewResultPayload } from '@termrelay/contracts';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { FilePreviewService } from './file-preview.service';
import type { SessionsService } from './sessions.service';

function setup() {
  const registry = new DeviceConnectionRegistry();
  const sent: { data: { payload: { requestId: string } } }[] = [];
  const client = { send: (message: string) => { sent.push(JSON.parse(message)); } } as unknown as WebSocket;
  registry.connect(client);
  registry.register(client, 'device-a', {
    name: 'Mac', appVersion: '1', platform: 'macOS', tools: [],
  });
  const sessions = { findById: async (id: string) => id === 'session-a'
    ? { id, deviceId: 'device-a', workspaceId: 'workspace-a', runtimeMode: 'acp' } : null } as SessionsService;
  return { service: new FilePreviewService(sessions, registry), sent, client };
}

function reply(requestId: string, payload: Partial<FilePreviewResultPayload> = {}): Envelope<FilePreviewResultPayload> {
  return {
    type: 'file.preview.result', protocolVersion: '2', messageId: randomUUID(),
    deviceId: 'device-a', sessionId: 'session-a', sentAt: new Date().toISOString(),
    payload: { requestId, status: 'ok', name: 'readme.md', content: '# Hello', ...payload },
  };
}

test('relays a preview to its session Mac and returns only the matching response', async () => {
  const { service, sent, client } = setup();
  const promise = service.preview('session-a', '/Users/me/work/readme.md');
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = sent[0]?.data.payload.requestId;
  assert.ok(requestId);
  assert.equal(service.accept({} as WebSocket, reply(requestId)), false);
  assert.equal(service.accept(client, { ...reply(requestId), sessionId: 'session-b' }), false);
  assert.equal(service.accept(client, reply(requestId)), true);
  assert.deepEqual(await promise, { name: 'readme.md', content: '# Hello' });
  assert.equal(service.accept(client, reply(requestId)), false);
});

test('rejects unrelated paths and offline or missing sessions', async () => {
  const { service } = setup();
  await assert.rejects(service.preview('session-a', '/etc/passwd'), { status: 400 });
  await assert.rejects(service.preview('other', '/Users/me/work/readme.md'), { status: 404 });
});

test('does not return oversized or denied Mac contents', async () => {
  const { service, sent, client } = setup();
  const promise = service.preview('session-a', '/Users/me/work/readme.md');
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = sent[0]?.data.payload.requestId;
  assert.ok(requestId);
  assert.equal(service.accept(client, reply(requestId, { content: 'x'.repeat(512 * 1024 + 1) })), true);
  await assert.rejects(promise, { status: 502 });

  const denied = service.preview('session-a', '/Users/me/work/readme.md');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.accept(client, reply(sent[1]!.data.payload.requestId, {
    status: 'forbidden', name: undefined, content: undefined,
  })), true);
  await assert.rejects(denied, { status: 400 });
});
