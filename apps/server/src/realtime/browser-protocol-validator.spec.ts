import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BrowserProtocolValidator } from './browser-protocol-validator';

const validator = new BrowserProtocolValidator();

test('accepts subscribe and unsubscribe with session context', () => {
  assert.equal(
    validator.validate(envelope('session.subscribe', { afterSeq: -1 })).ok,
    true,
  );
  assert.equal(
    validator.validate(envelope('session.unsubscribe', {})).ok,
    true,
  );
});

test('rejects missing sessions, invalid payloads, and unknown messages', () => {
  const missingSession = envelope('session.subscribe', {});
  const { sessionId: _sessionId, ...withoutSession } = missingSession;
  assert.equal(validator.validate(withoutSession).ok, false);
  assert.equal(
    validator.validate(envelope('session.subscribe', { afterSeq: -2 })).ok,
    false,
  );
  assert.equal(validator.validate(envelope('session.input', {})).ok, false);
});

function envelope(type: string, payload: Record<string, unknown>) {
  return {
    type,
    protocolVersion: '1',
    messageId: randomUUID(),
    deviceId: 'device-a',
    sessionId: 'session-a',
    sentAt: new Date().toISOString(),
    payload,
  };
}
