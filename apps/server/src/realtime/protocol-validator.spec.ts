import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ProtocolValidator } from './protocol-validator';

const validator = new ProtocolValidator();

test('validates file preview replies without treating them as session events', () => {
  const payload = { requestId: randomUUID(), status: 'ok', name: 'readme.md', content: '# Hello' };
  assert.equal(validator.validate({ ...envelope('file.preview.result', payload), sessionId: 'session-a' }).ok, true);
  assert.equal(validator.validate(envelope('file.preview.result', payload)).ok, false);
  assert.equal(validator.validate({ ...envelope('file.preview.result', payload), sessionId: 'session-a', seq: 1 }).ok, false);
  assert.equal(validator.validate({
    ...envelope('file.preview.result', { requestId: randomUUID(), status: 'ok' }),
    sessionId: 'session-a',
  }).ok, false);
  assert.equal(validator.validate({
    ...envelope('file.preview.result', { requestId: randomUUID(), status: 'forbidden', content: 'secret' }),
    sessionId: 'session-a',
  }).ok, false);
});

test('accepts a valid device.register envelope and payload', () => {
  const result = validator.validate(
    envelope('device.register', {
      name: 'Development Mac',
      appVersion: '0.1.0',
      platform: 'macOS',
      tools: ['codex', 'shell'],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.message.type, 'device.register');
});

test('accepts a valid heartbeat', () => {
  const result = validator.validate(
    envelope('device.heartbeat', {
      connectionState: 'degraded',
      activeSessionCount: 2,
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.message.type, 'device.heartbeat');
});

test('accepts command acknowledgements with matching command context', () => {
  const commandId = randomUUID();
  const result = validator.validate({
    ...envelope('command.ack', { commandId, status: 'completed' }),
    sessionId: 'session-a',
    commandId,
  });
  assert.equal(result.ok, true);

  const mismatch = validator.validate({
    ...envelope('command.ack', { commandId: randomUUID(), status: 'completed' }),
    sessionId: 'session-a',
    commandId,
  });
  assert.equal(mismatch.ok, false);
});

test('validates history requests and their envelope context', () => {
    assert.equal(validator.validate(envelope('session.history.list', {})).ok, true);
    assert.equal(validator.validate(envelope('session.history.list', { cursor: 'YWJj.ZGVm' })).ok, true);
    assert.equal(validator.validate({
      ...envelope('session.history.list', {}), sessionId: 'session-a',
    }).ok, false);
    assert.equal(validator.validate(envelope('session.history.list', { cursor: 'invalid' })).ok, false);
    assert.equal(validator.validate(envelope('session.history.list', { unknown: true })).ok, false);
    assert.equal(validator.validate({
      ...envelope('session.history.request', { beforeSeq: 0, limit: 50 }),
      sessionId: 'session-a',
    }).ok, true);
    assert.equal(validator.validate(envelope('session.history.request', {})).ok, false);
    assert.equal(validator.validate({
      ...envelope('session.history.request', { limit: 51 }), sessionId: 'session-a',
    }).ok, false);
    assert.equal(validator.validate({
      ...envelope('session.history.request', { beforeSeq: -1 }), sessionId: 'session-a',
    }).ok, false);
    assert.equal(validator.validate({
      ...envelope('session.history.request', {}), sessionId: 'session-a', seq: 0,
    }).ok, false);
});

test('accepts workspace, session, and terminal events with required context', () => {
  const workspace = validator.validate(
    envelope('workspace.registered', {
      workspaceId: 'workspace-a',
      displayName: 'Workspace A',
      available: true,
      remoteStartAllowed: false,
    }),
  );
  assert.equal(workspace.ok, true);

  const started = validator.validate({
    ...envelope('session.started', {
      workspaceId: 'workspace-a',
      toolKey: 'codex',
      displayName: '后端服务',
      runtimeMode: 'pty',
      startedAt: new Date().toISOString(),
    }),
    sessionId: 'session-a',
    seq: 0,
  });
  assert.equal(started.ok, true);

  const output = validator.validate({
    ...envelope('terminal.output', {
      encoding: 'base64',
      data: Buffer.from('hello').toString('base64'),
    }),
    sessionId: 'session-a',
    seq: 1,
  });
  assert.equal(output.ok, true);

  const ended = validator.validate({
    ...envelope('session.ended', {
      status: 'finished',
      finishedAt: new Date().toISOString(),
    }),
    sessionId: 'session-a',
  });
  assert.equal(ended.ok, true);

  const sync = validator.validate({
    ...envelope('session.sync', { autoApproveEnabled: true }),
    sessionId: 'session-a',
  });
  assert.equal(sync.ok, true);

  const invalidSync = validator.validate({
    ...envelope('session.sync', { autoApproveEnabled: 'yes' }),
    sessionId: 'session-a',
  });
  assert.equal(invalidSync.ok, false);
});

test('accepts normalized structured Agent events and rejects incomplete approvals', () => {
  const validator = new ProtocolValidator();
  const accepted = validator.validate({
    ...envelope('tool.event', {
      kind: 'approval.requested',
      occurredAt: new Date().toISOString(),
      correlation: { turnId: 'turn-1', approvalId: 'approval-1' },
      data: {
        approvalId: 'approval-1', turnId: 'turn-1', kind: 'command', risk: 'high',
        title: 'Run command', availableDecisions: ['allowOnce', 'allowSession', 'deny', 'cancel'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    sessionId: 'session-a',
    seq: 1,
  });
  assert.equal(accepted.ok, true);

  const rejected = validator.validate({
    ...envelope('tool.event', {
      kind: 'approval.requested',
      occurredAt: new Date().toISOString(),
      correlation: {},
      data: { approvalId: 'approval-1' },
    }),
    sessionId: 'session-a',
    seq: 1,
  });
  assert.equal(rejected.ok, false);
});

test('validates acknowledged session configuration snapshots', () => {
  const snapshot = (options: unknown) => ({
    ...envelope('tool.event', {
      kind: 'config.updated', occurredAt: new Date().toISOString(), correlation: {}, data: { options },
    }),
    sessionId: 'session-a', seq: 1,
  });
  assert.equal(validator.validate(snapshot([
    { id: 'model', name: '模型', currentValue: 'model-a', choices: [{ value: 'model-a', name: 'Model A' }] },
  ])).ok, true);
  assert.equal(validator.validate(snapshot([{ id: 'sandbox', name: 'Unsafe', currentValue: 'off', choices: [] }])).ok, false);
});

test('rejects session events without context and malformed base64', () => {
  const missingContext = validator.validate(
    envelope('session.started', {
      workspaceId: 'workspace-a',
      toolKey: 'codex',
      runtimeMode: 'pty',
      startedAt: new Date().toISOString(),
    }),
  );
  assert.equal(missingContext.ok, false);
  if (!missingContext.ok) assert.match(missingContext.detail, /sessionId/u);

  const invalidOutput = validator.validate({
    ...envelope('terminal.output', { encoding: 'base64', data: 'not base64' }),
    sessionId: 'session-a',
    seq: 1,
  });
  assert.equal(invalidOutput.ok, false);

  const invalidEnd = validator.validate({
    ...envelope('session.ended', {
      status: 'finished',
      finishedAt: new Date().toISOString(),
    }),
    seq: 2,
  });
  assert.equal(invalidEnd.ok, false);
});

test('rejects unsupported protocol versions distinctly', () => {
  const message = { ...envelope('device.heartbeat', { connectionState: 'connected' }) };
  message.protocolVersion = '999';
  const result = validator.validate(message);

  assert.deepEqual(
    result.ok ? undefined : result.code,
    'unsupported_version',
  );
});

test('rejects malformed envelopes, unknown message types, and invalid payloads', () => {
  const malformed = validator.validate({ type: 'device.register' });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.code, 'invalid_message');

  const unknown = validator.validate(envelope('unknown.event', {}));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.detail, /Unsupported client message type/u);

  const invalidPayload = validator.validate(
    envelope('device.register', {
      name: '',
      appVersion: '0.1.0',
      platform: 'linux',
      tools: ['codex', 'codex'],
    }),
  );
  assert.equal(invalidPayload.ok, false);
  if (!invalidPayload.ok) assert.match(invalidPayload.detail, /payload/u);
});

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    type,
    protocolVersion: '2',
    messageId: randomUUID(),
    deviceId: 'device-test-1',
    sentAt: new Date().toISOString(),
    payload,
  };
}
