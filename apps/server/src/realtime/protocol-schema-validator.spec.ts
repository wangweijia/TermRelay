import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BrowserProtocolValidator } from './browser-protocol-validator';
import { ProtocolValidator, type ValidClientMessage } from './protocol-validator';

const client = new ProtocolValidator();
const browser = new BrowserProtocolValidator();

test('every supported client message preserves its validated type, envelope and payload', () => {
  const commandId = randomUUID();
  const now = new Date().toISOString();
  const fixtures: {
    [Type in ValidClientMessage['type']]: Pick<
      Extract<ValidClientMessage, { type: Type }>['envelope'],
      'payload' | 'sessionId' | 'seq' | 'commandId'
    >;
  } = {
    'ai.capabilities': { payload: { providers: [{ provider: 'codex', capacity: 1, workspaceEnabled: false }] } },
    'ai.update': { payload: { id: randomUUID(), status: 'ready' } },
    'device.register': { payload: { name: 'Mac', appVersion: '1', platform: 'macOS', tools: ['codex'] } },
    'device.heartbeat': { payload: { connectionState: 'connected' } },
    'workspace.registered': { payload: { workspaceId: 'workspace-a', displayName: 'A', available: true, remoteStartAllowed: false } },
    'session.started': {
      sessionId: 'session-a', seq: 0,
      payload: { workspaceId: 'workspace-a', toolKey: 'codex', runtimeMode: 'acp', startedAt: now },
    },
    'session.ended': { sessionId: 'session-a', payload: { status: 'finished', finishedAt: now } },
    'session.sync': { sessionId: 'session-a', payload: {} },
    'session.history.list': { payload: {} },
    'session.history.request': { sessionId: 'session-a', payload: {} },
    'session.history.delete': { sessionId: 'session-a', payload: { purge: false } },
    'terminal.output': { sessionId: 'session-a', seq: 1, payload: { encoding: 'base64', data: 'aGk=' } },
    'tool.event': {
      sessionId: 'session-a', seq: 1,
      payload: { kind: 'assistant.delta', occurredAt: now, correlation: {}, data: { text: 'hello' } },
    },
    'command.ack': { sessionId: 'session-a', commandId, payload: { commandId, status: 'completed' } },
    'shortcut.catalog': { payload: { shortcuts: [] } },
    'shortcut.run.update': { payload: { runId: randomUUID(), status: 'running' } },
    'shortcut.run.input.ack': { payload: { runId: randomUUID(), commandId, status: 'accepted' } },
    'file.preview.result': { sessionId: 'session-a', payload: { requestId: randomUUID(), status: 'not_found' } },
  };
  for (const [type, fixture] of Object.entries(fixtures)) {
    const input = { ...envelope(type), ...fixture };
    const result = client.validate(input);
    assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.message.type, type);
      assert.equal(result.message.envelope, input);
      assert.equal(result.message.envelope.payload, fixture.payload);
    }
  }
});

const directions = [
  { source: 'client', validator: client, input: envelope('device.heartbeat', { connectionState: 'connected' }) },
  { source: 'browser', validator: browser, input: { ...envelope('session.subscribe'), sessionId: 'session-a' } },
] as const;

test('shared validation preserves version errors and only echoes valid message IDs', () => {
  for (const { validator, input } of directions) {
    assert.deepEqual(validator.validate({ ...input, protocolVersion: '1' }), {
      ok: false, code: 'unsupported_version', detail: 'Only protocol version 2 is supported.',
      relatedMessageId: input.messageId,
    });
    assert.deepEqual(validator.validate({ ...input, protocolVersion: '1', messageId: 'invalid' }), {
      ok: false, code: 'unsupported_version', detail: 'Only protocol version 2 is supported.',
    });
    const invalid = validator.validate({ ...input, messageId: 'invalid' });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.code, 'invalid_message');
      assert.equal(Object.hasOwn(invalid, 'relatedMessageId'), false);
    }
  }
});

test('shared validation rejects malformed envelopes, UUIDs and timestamps for both directions', () => {
  for (const { validator, input } of directions) {
    for (const malformed of [
      null, undefined, [], 'message', 42, {},
      { ...input, sentAt: 'not-a-date' },
      { ...input, sentAt: '2026-99-01T00:00:00Z' },
      { ...input, commandId: 'not-a-uuid' },
      { ...input, payload: [] },
      { ...input, unexpected: true },
    ]) {
      const result = validator.validate(malformed);
      assert.equal(result.ok, false, JSON.stringify(malformed));
      if (!result.ok) assert.equal(result.code, 'invalid_message');
    }
    assert.equal(validator.validate({ ...input, sentAt: '2026-01-01T08:00:00+08:00' }).ok, true);
  }
});

test('each direction rejects unsupported messages rather than sharing its allowed type list', () => {
  for (const { source, validator, input } of directions) {
    const type = source === 'client' ? 'session.subscribe' : 'device.heartbeat';
    assert.deepEqual(validator.validate({ ...input, type }), {
      ok: false, code: 'invalid_message',
      detail: `Unsupported ${source} message type: ${type}`, relatedMessageId: input.messageId,
    });
  }
});

test('shared schema failures retain bounded details and correlation IDs', () => {
  const extra = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`extra${index}`, true]));
  for (const { validator, input } of directions) {
    const result = validator.validate({ ...input, ...extra });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'invalid_message');
      assert.equal(result.detail.length, 1_500);
      assert.equal(result.relatedMessageId, input.messageId);
    }
  }
});

test('client sync keeps its restricted payload and client-specific semantic checks', () => {
  assert.equal(client.validate({
    ...envelope('session.sync', { autoApproveEnabled: false }), sessionId: 'session-a',
  }).ok, true);
  assert.equal(client.validate({
    ...envelope('session.sync', { autoApproveEnabled: false, lastAckSeq: 1 }), sessionId: 'session-a',
  }).ok, false);
  const provider = { provider: 'codex', capacity: 1, workspaceEnabled: false };
  const result = client.validate(envelope('ai.capabilities', { providers: [provider, provider] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail, 'AI providers must be unique.');
});

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return {
    type, protocolVersion: '2', messageId: randomUUID(), deviceId: 'device-a',
    sentAt: new Date().toISOString(), payload,
  };
}
