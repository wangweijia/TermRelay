import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ProtocolValidator } from './protocol-validator';

const validator = new ProtocolValidator();

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
      runtimeMode: 'terminal',
      webDisplayMode: 'full',
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
        title: 'Run command', expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

test('rejects session events without context and malformed base64', () => {
  const missingContext = validator.validate(
    envelope('session.started', {
      workspaceId: 'workspace-a',
      toolKey: 'codex',
      runtimeMode: 'terminal',
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
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId: 'device-test-1',
    sentAt: new Date().toISOString(),
    payload,
  };
}
