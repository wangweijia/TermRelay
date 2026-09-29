export type ShortcutAnswer = 'y' | 'n' | 'yes' | 'no';

export interface PendingShortcutInput {
  runId: string;
  commandId: string;
  answer: ShortcutAnswer;
}

export function parsePendingShortcutInput(saved: string | null): PendingShortcutInput | undefined {
  if (saved === null) return undefined;
  const value: unknown = JSON.parse(saved);
  if (typeof value !== 'object' || value === null ||
    !('runId' in value) || typeof value.runId !== 'string' || !value.runId ||
    !('commandId' in value) || typeof value.commandId !== 'string' || !value.commandId ||
    !('answer' in value) || typeof value.answer !== 'string' ||
    !['y', 'n', 'yes', 'no'].includes(value.answer)) {
    throw new Error('无效的待确认输入');
  }
  return value as PendingShortcutInput;
}

export function inputDeliveryUncertain(status: number, detail?: string): boolean {
  return status === 408 || status === 429 || status >= 500 ||
    (status === 409 && /delivery is unknown/i.test(detail ?? ''));
}

export function inputAcknowledged(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'accepted' in body && body.accepted === true;
}
