export type ApprovalOutcome = 'approved' | 'denied' | 'cancelled' | 'processed';

export function approvalPresentation(decision: unknown): { outcome: ApprovalOutcome; label: string; icon: string } {
  switch (decision) {
    case 'allowOnce': return { outcome: 'approved', label: '已通过 · 允许一次', icon: '✓' };
    case 'allowSession': return { outcome: 'approved', label: '已通过 · 本会话允许', icon: '✓' };
    case 'allowPolicy': return { outcome: 'approved', label: '已通过 · 已应用规则', icon: '✓' };
    case 'deny': return { outcome: 'denied', label: '已拒绝', icon: '×' };
    case 'cancel': return { outcome: 'cancelled', label: '已取消', icon: '–' };
    default: return { outcome: 'processed', label: '审批已处理', icon: '·' };
  }
}
