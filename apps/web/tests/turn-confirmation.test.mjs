import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTurnAck, applyTurnProtocolError, expireTurnWaits, restoreTurnReceipts, MAX_TURN_RECEIPTS } from '../src/turn-confirmation.ts';

const commandId = '10000000-0000-4000-8000-000000000001';
const messageId = '20000000-0000-4000-8000-000000000001';
function receipt() { return { commandId, messageId, deviceId: 'mac', sessionId: 'session', state: 'waiting', createdAt: 1000 }; }
function ack(record, status, scope = {}) {
  applyTurnAck(record, scope.deviceId ?? 'mac', scope.sessionId ?? 'session', { commandId: scope.commandId ?? commandId, status });
}

test('accepted is not final; timeout remains recoverable through late or duplicate confirmation', () => {
  const record = receipt();
  ack(record, 'accepted');
  assert.equal(record.state, 'waiting');
  expireTurnWaits([record], 35_999);
  assert.equal(record.state, 'waiting');
  expireTurnWaits([record], 36_000);
  assert.equal(record.state, 'unknown');
  ack(record, 'completed');
  assert.equal(record.state, 'confirmed');
  for (const status of ['accepted', 'completed', 'failed', 'rejected']) ack(record, status);
  expireTurnWaits([record], 99_000);
  assert.equal(record.state, 'confirmed');
});

test('wrong command, session and device cannot confirm another submission', () => {
  const record = receipt();
  for (const scope of [{ commandId: messageId }, { deviceId: 'other' }, { sessionId: 'other' }]) {
    ack(record, 'completed', scope);
    assert.equal(record.state, 'waiting');
  }
  ack(record, 'completed', { commandId: commandId.toUpperCase() });
  assert.equal(record.state, 'confirmed');
});

test('protocol rejection is correlated to outbound messageId, not commandId', () => {
  const record = receipt();
  applyTurnProtocolError([record], { relatedMessageId: commandId, code: 'unknown_device' });
  assert.equal(record.state, 'waiting');
  applyTurnProtocolError([record], { relatedMessageId: messageId, code: 'unknown_device' });
  assert.equal(record.state, 'not_sent');
});

test('transport timeout, conflicts and ambiguous device failures never claim safe retry', () => {
  for (const status of ['rejected', 'failed']) {
    const record = receipt();
    ack(record, status);
    assert.equal(record.state, 'unknown');
  }
  for (const code of ['internal_error', 'conflict']) {
    const record = receipt();
    applyTurnProtocolError([record], { relatedMessageId: messageId, code });
    assert.equal(record.state, 'unknown');
  }
});

test('reload restores only bounded metadata, preserves unknowns and never claims timeout failure', () => {
  const raw = { ...receipt(), text: 'secret draft', attachments: ['private-file'], token: 'secret' };
  const restored = restoreTurnReceipts(JSON.stringify([raw]), 2000);
  assert.deepEqual(restored[commandId], { ...receipt(), state: 'unknown' });
  assert.doesNotMatch(JSON.stringify(restored), /secret|private-file/);
  for (const invalid of [null, '{}', '{broken', JSON.stringify([{ ...raw, commandId: '__proto__' }]), JSON.stringify([{ ...raw, createdAt: 3000 }])]) {
    assert.deepEqual(restoreTurnReceipts(invalid, 2000), {});
  }
  assert.deepEqual(restoreTurnReceipts(JSON.stringify([raw]), 8 * 24 * 60 * 60_000), {});
  const many = Array.from({ length: 500 }, (_, i) => ({ ...receipt(), commandId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
  assert.equal(Object.keys(restoreTurnReceipts(JSON.stringify(many), 2000)).length, MAX_TURN_RECEIPTS);
});
