import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { CommandAckPayload, Envelope } from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { SessionsService } from '../sessions/sessions.service';
import { DeviceConnectionRegistry } from './device-connection.registry';

export type RemoteCommandType =
  | 'terminal.input'
  | 'terminal.resize'
  | 'session.interrupt'
  | 'session.stop';

export interface CommandRouteError {
  ok: false;
  code: 'unknown_device' | 'unknown_session' | 'conflict' | 'internal_error';
  detail: string;
}

export type CommandAcknowledgementResult =
  | 'acknowledged'
  | 'ignored'
  | 'connection_mismatch';

interface PendingCommand {
  browser: WebSocket;
  deviceId: string;
  sessionId: string;
  commandId: string;
  type: RemoteCommandType;
  timer: NodeJS.Timeout;
}

@Injectable()
export class CommandRelayService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingCommand>();
  private readonly timeoutMs = readPositiveInteger('COMMAND_ACK_TIMEOUT_MS', 15_000);

  constructor(
    private readonly registry: DeviceConnectionRegistry,
    private readonly sessions: SessionsService,
  ) {}

  onModuleDestroy(): void {
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
  }

  async route(
    browser: WebSocket,
    envelope: Envelope<Record<string, unknown>>,
  ): Promise<{ ok: true } | CommandRouteError> {
    const sessionId = envelope.sessionId!;
    const commandId = normalizeCommandId(envelope.commandId!);
    const session = await this.sessions.findById(sessionId);
    if (!session || session.deviceId !== envelope.deviceId) {
      return {
        ok: false,
        code: 'unknown_session',
        detail: 'Session does not exist for the requested device.',
      };
    }
    if (!['starting', 'running'].includes(session.status)) {
      return {
        ok: false,
        code: 'conflict',
        detail: `Session is ${session.status} and cannot accept commands.`,
      };
    }
    if (this.pending.has(commandId)) {
      return {
        ok: false,
        code: 'conflict',
        detail: 'Command ID is already pending.',
      };
    }

    const client = this.registry.getClient(envelope.deviceId);
    if (!client) {
      return {
        ok: false,
        code: 'unknown_device',
        detail: 'The target Mac is offline.',
      };
    }

    const timer = setTimeout(() => this.timeout(commandId), this.timeoutMs);
    timer.unref();
    this.pending.set(commandId, {
      browser,
      deviceId: envelope.deviceId,
      sessionId,
      commandId,
      type: envelope.type as RemoteCommandType,
      timer,
    });

    try {
      client.send(JSON.stringify({ event: 'message', data: envelope }));
      return { ok: true };
    } catch {
      clearTimeout(timer);
      this.pending.delete(commandId);
      return {
        ok: false,
        code: 'internal_error',
        detail: 'Failed to send the command to the target Mac.',
      };
    }
  }

  async acknowledge(
    client: WebSocket,
    envelope: Envelope<CommandAckPayload>,
  ): Promise<CommandAcknowledgementResult> {
    const commandId = normalizeCommandId(envelope.commandId!);
    const pending = this.pending.get(commandId);
    // ACKs can legitimately arrive after a timeout or Server restart. They are
    // idempotent completion messages, so a missing pending entry is harmless.
    if (!pending) return 'ignored';
    if (
      pending.deviceId !== envelope.deviceId ||
      pending.sessionId !== envelope.sessionId ||
      !this.registry.isRegisteredClient(client, envelope.deviceId)
    ) {
      return 'connection_mismatch';
    }

    send(pending.browser, envelope);
    if (envelope.payload.status !== 'accepted') {
      clearTimeout(pending.timer);
      this.pending.delete(commandId);
      if (pending.type === 'session.stop' && envelope.payload.status === 'completed') {
        await this.sessions.finishSession(pending.sessionId);
      }
    }
    return 'acknowledged';
  }

  private timeout(commandId: string): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    const payload: CommandAckPayload = {
      commandId,
      status: 'failed',
      errorCode: 'ack_timeout',
      message: `Mac did not acknowledge the command within ${this.timeoutMs} ms.`,
    };
    send(pending.browser, {
      type: 'command.ack',
      protocolVersion: '1',
      messageId: randomUUID(),
      deviceId: pending.deviceId,
      sessionId: pending.sessionId,
      commandId,
      sentAt: new Date().toISOString(),
      payload,
    });
  }
}

function send(client: WebSocket, envelope: Envelope<CommandAckPayload>): void {
  try {
    client.send(JSON.stringify({ event: 'message', data: envelope }));
  } catch {
    // The browser may have disconnected while the command was in flight.
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeCommandId(commandId: string): string {
  return commandId.toLowerCase();
}
