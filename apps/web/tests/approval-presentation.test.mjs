import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalPresentation } from '../src/approval-presentation.ts';

test('approved decisions show a positive outcome and the actual approval scope', () => {
  for (const [decision, label] of [
    ['allowOnce', '已通过 · 允许一次'],
    ['allowSession', '已通过 · 本会话允许'],
    ['allowPolicy', '已通过 · 已应用规则'],
  ]) {
    assert.deepEqual(approvalPresentation(decision), { outcome: 'approved', label, icon: '✓' });
  }
});

test('rejection, cancellation and unknown decisions never appear approved', () => {
  assert.equal(approvalPresentation('deny').outcome, 'denied');
  assert.equal(approvalPresentation('cancel').outcome, 'cancelled');
  assert.deepEqual(approvalPresentation(undefined), { outcome: 'processed', label: '审批已处理', icon: '·' });
});
