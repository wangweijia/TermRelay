import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { CommandAckPayload, Envelope } from '@termrelay/contracts';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { canonicalJson } from '../common/json';

export interface TurnCommandRecord {
  commandId: string;
  deviceId: string;
  sessionId: string;
  requestHash: string;
  ack: CommandAckPayload | null;
}

// Retain command IDs as tombstones: deleting them could permit a second execution.
// Payloads and attachment contents are never stored here.
@Injectable()
export class TurnCommandRepository {
  private readonly memory = new Map<string, TurnCommandRecord>();
  constructor(@Optional() @InjectDataSource() private readonly source?: DataSource) {}

  async find(id: string): Promise<TurnCommandRecord | undefined> {
    if (!this.source) return this.memory.get(id.toLowerCase());
    const rows: Array<{ command_id: string; device_id: string; session_id: string; request_hash: string; acknowledgement: CommandAckPayload | string | null }> = await this.source.query(
      'SELECT command_id, device_id, session_id, request_hash, acknowledgement FROM commands WHERE command_id = ?', [id.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { commandId: row.command_id, deviceId: row.device_id, sessionId: row.session_id,
      requestHash: row.request_hash, ack: typeof row.acknowledgement === 'string' ? JSON.parse(row.acknowledgement) as CommandAckPayload : row.acknowledgement };
  }

  async reserve(envelope: Envelope<unknown>): Promise<boolean> {
    const commandId = envelope.commandId!.toLowerCase();
    const requestHash = createHash('sha256').update(canonicalJson({ type: envelope.type, payload: envelope.payload })).digest('hex');
    if (!this.source) {
      if (this.memory.has(commandId)) return false;
      // DB-disabled development remains usable, with an explicit bounded fallback.
      if (this.memory.size >= 2048) throw new ServiceUnavailableException('Command tracking is full; enable database persistence.');
      this.memory.set(commandId, { commandId, deviceId: envelope.deviceId, sessionId: envelope.sessionId!, requestHash, ack: null });
      return true;
    }
    try {
      await this.source.query(`INSERT INTO commands (command_id, device_id, session_id, type, request_hash)
        VALUES (?, ?, ?, ?, ?)`, [commandId, envelope.deviceId, envelope.sessionId, envelope.type, requestHash]);
      return true;
    } catch (error: unknown) {
      if ((error as { driverError?: { code?: string } }).driverError?.code === 'ER_DUP_ENTRY') return false;
      throw error;
    }
  }

  async acknowledge(id: string, ack: CommandAckPayload): Promise<void> {
    const normalized = { ...ack, commandId: id.toLowerCase() };
    if (!this.source) {
      const record = this.memory.get(id.toLowerCase());
      if (record && (!record.ack || record.ack.status === 'accepted')) record.ack = normalized;
      return;
    }
    // First terminal outcome wins. An accepted ACK arriving late cannot undo it.
    await this.source.query(`UPDATE commands SET status = ?, acknowledgement = ?,
      completed_at = IF(? = 'accepted', NULL, CURRENT_TIMESTAMP(3))
      WHERE command_id = ? AND status IN ('pending', 'accepted')`,
    [ack.status, JSON.stringify(normalized), ack.status, id.toLowerCase()]);
  }
}
