import type { PendingApprovalRecord, SessionRecord } from './types';

export function visiblePendingApprovals(
  approvals: PendingApprovalRecord[],
  sessions: SessionRecord[],
): PendingApprovalRecord[] {
  const autoApproved = new Set(sessions.filter((session) => session.autoApproveEnabled)
    .map((session) => session.id));
  return approvals.filter((approval) => !autoApproved.has(approval.sessionId));
}
