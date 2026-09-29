import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputAcknowledged, inputDeliveryUncertain, parsePendingShortcutInput } from '../src/shortcut-input.ts';

test('only the four fixed answers and a run-scoped command ID can be restored', () => {
  const pending = { runId: 'run-1', commandId: 'command-1', answer: 'yes' };
  assert.deepEqual(parsePendingShortcutInput(JSON.stringify(pending)), pending);
  assert.equal(parsePendingShortcutInput(null), undefined);
  for (const invalid of [
    { ...pending, answer: 'secret' },
    { ...pending, answer: ['yes'] },
    { ...pending, runId: '' },
    { ...pending, commandId: null },
  ]) {
    assert.throws(() => parsePendingShortcutInput(JSON.stringify(invalid)));
  }
  assert.throws(() => parsePendingShortcutInput('{broken'));
});

test('only explicit acknowledgement succeeds; timeout and server errors remain retryable', () => {
  assert.equal(inputAcknowledged({ accepted: true }), true);
  for (const body of [{ accepted: false }, { accepted: 'true' }, undefined]) {
    assert.equal(inputAcknowledged(body), false);
  }
  for (const status of [408, 429, 500, 503, 504]) assert.equal(inputDeliveryUncertain(status), true);
  for (const status of [400, 403, 404, 409, 422]) assert.equal(inputDeliveryUncertain(status), false);
  assert.equal(inputDeliveryUncertain(409, 'Device disconnected; shortcut input delivery is unknown.'), true);
  assert.equal(inputDeliveryUncertain(409, 'shortcut input rejected by device'), false);
});
