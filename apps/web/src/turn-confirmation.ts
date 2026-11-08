import type { CommandAckPayload } from './types';

export type TurnState = 'waiting' | 'unknown' | 'confirmed' | 'not_sent';
export interface TurnReceipt {
  commandId: string;
  messageId: string;
  deviceId: string;
  sessionId: string;
  createdAt: number;
  state: TurnState;
}
export const TURN_RECEIPTS_KEY = 'termrelay.turnReceipts.v1';
export const TURN_WAIT_MS = 35_000;
export const TURN_POLL_MS = 10 * 60_000;
export const MAX_TURN_RECEIPTS = 128;

export function applyTurnAck(record: TurnReceipt, deviceId: string, sessionId: string | undefined, ack: CommandAckPayload): void {
  if (deviceId !== record.deviceId || sessionId !== record.sessionId || ack.commandId.toLowerCase() !== record.commandId) return;
  if (record.state === 'confirmed' || record.state === 'not_sent') return;
  if (ack.status === 'completed') record.state = 'confirmed';
  // Device errors may follow an ambiguous provider RPC; never promise safe retry.
  else if (ack.status === 'failed' || ack.status === 'rejected') record.state = 'unknown';
}

export function applyTurnProtocolError(records: TurnReceipt[], error: { relatedMessageId?: string; code?: string }): TurnReceipt | undefined {
  const record = records.find(item => item.messageId === error.relatedMessageId);
  if (!record) return undefined;
  if (record.state === 'confirmed' || record.state === 'not_sent') return record;
  record.state = ['invalid_message', 'unknown_device', 'unknown_session', 'unauthorized_workspace', 'unsupported_version'].includes(error.code ?? '') ? 'not_sent' : 'unknown';
  return record;
}

export function expireTurnWaits(records: TurnReceipt[], now = Date.now()): void {
  for (const record of records) if (record.state === 'waiting' && now - record.createdAt >= TURN_WAIT_MS) record.state = 'unknown';
}

export function restoreTurnReceipts(raw: string | null, now = Date.now()): Record<string, TurnReceipt> {
  const result: Record<string, TurnReceipt> = {};
  try {
    const values: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(values)) return result;
    for (const item of values.slice(-MAX_TURN_RECEIPTS)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as TurnReceipt;
      if (![record.commandId, record.messageId].every(id => typeof id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(id)) ||
        typeof record.deviceId !== 'string' || typeof record.sessionId !== 'string' || record.deviceId.length > 128 || record.sessionId.length > 128 ||
        !Number.isFinite(record.createdAt) || record.createdAt > now || now - record.createdAt > 7 * 24 * 60 * 60_000 ||
        !['waiting', 'unknown', 'confirmed', 'not_sent'].includes(record.state)) continue;
      // Whitelist fields: never restore draft text, file contents, or credentials.
      result[record.commandId] = { commandId: record.commandId, messageId: record.messageId, deviceId: record.deviceId,
        sessionId: record.sessionId, createdAt: record.createdAt, state: record.state === 'waiting' ? 'unknown' : record.state };
    }
  } catch { /* Storage is optional. */ }
  return result;
}
