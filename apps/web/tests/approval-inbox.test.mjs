import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visiblePendingApprovals } from '../src/approval-inbox.ts';

test('auto-approved session requests never appear in the pending approval list', () => {
  const approvals = [
    { sessionId: 'automatic', approvalId: 'auto' },
    { sessionId: 'manual', approvalId: 'manual' },
  ];
  const sessions = [
    { id: 'automatic', autoApproveEnabled: true },
    { id: 'manual', autoApproveEnabled: false },
  ];

  assert.deepEqual(visiblePendingApprovals(approvals, sessions), [approvals[1]]);
  sessions[0].autoApproveEnabled = false;
  assert.deepEqual(visiblePendingApprovals(approvals, sessions), approvals);
});
