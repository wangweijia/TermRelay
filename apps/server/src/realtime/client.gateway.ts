import { Logger, Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type {
  DeviceRegisteredPayload,
  Envelope,
  ProtocolErrorCode,
  ProtocolErrorPayload,
  SessionHistoryListedPayload,
  SessionHistoryPayload,
  SessionSyncedPayload,
} from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { ClientConnectionAuthorizations } from '../client-auth/client-connection-authorizations';
import { SessionsService } from '../sessions/sessions.service';
import { DeviceConnectionRegistry } from './device-connection.registry';
import { CommandRelayService } from './command-relay.service';
import {
  ProtocolValidator,
  type ValidClientMessage,
} from './protocol-validator';

const HISTORY_LIST_LIMIT = 100;
const HISTORY_EVENT_LIMIT = 50;
const HISTORY_EVENT_BYTES = 2_000_000;

function encodeHistoryCursor(session: { updatedAt: string; id: string }): string {
  return `${Buffer.from(session.updatedAt).toString('base64url')}.${Buffer.from(session.id).toString('base64url')}`;
}

function parseHistoryCursor(cursor: string): { updatedAt: Date; id: string } | undefined {
  const parts = cursor.split('.');
  if (parts.length !== 2) return undefined;
  const [encodedDate, encodedId] = parts;
  if (!encodedDate || !encodedId) return undefined;
  const dateText = Buffer.from(encodedDate, 'base64url').toString('utf8');
  const id = Buffer.from(encodedId, 'base64url').toString('utf8');
  if (!id || id.length > 128 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(dateText)
    || Buffer.from(dateText).toString('base64url') !== encodedDate
    || Buffer.from(id).toString('base64url') !== encodedId) return undefined;
  const updatedAt = new Date(dateText);
  return !Number.isNaN(updatedAt.getTime()) && updatedAt.toISOString() === dateText
    ? { updatedAt, id } : undefined;
}

@WebSocketGateway({ path: '/ws/client' })
export class ClientGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ClientGateway.name);

  constructor(
    private readonly validator: ProtocolValidator,
    private readonly registry: DeviceConnectionRegistry,
    private readonly sessions: SessionsService,
    @Optional() private readonly commands?: CommandRelayService,
    @Optional() private readonly authorizations?: ClientConnectionAuthorizations,
  ) {}

  handleConnection(client: WebSocket): void {
    if (this.isPublicGateway() && !this.authorizations?.get(client)) {
      client.close(1008, 'unauthorized');
      return;
    }

    this.registry.connect(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.registry.disconnect(client);
    this.authorizations?.detach(client);
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() input: unknown,
  ): Promise<void> {
    const result = this.validator.validate(input);
    if (!result.ok) {
      this.sendProtocolError(
        client,
        result.code,
        result.detail,
        result.relatedMessageId,
      );
      if (result.code === 'unsupported_version') {
        client.close(1002, 'unsupported protocol version');
      }
      return;
    }

    if (result.message.type === 'device.register') {
      const { envelope } = result.message;
      const authorizedDeviceId = this.authorizations?.get(client)?.deviceId;
      if (authorizedDeviceId && authorizedDeviceId !== envelope.deviceId) {
        this.rejectUnregistered(client, envelope.messageId);
        return;
      }
      const device = this.registry.register(
        client,
        envelope.deviceId,
        envelope.payload,
      );
      this.sendEnvelope<DeviceRegisteredPayload>(client, {
        type: 'device.registered',
        protocolVersion: '2',
        messageId: randomUUID(),
        deviceId: device.deviceId,
        sentAt: new Date().toISOString(),
        payload: {
          registeredAt: device.registeredAt,
          heartbeatIntervalMs: this.registry.heartbeatIntervalMs,
          heartbeatTimeoutMs: this.registry.heartbeatTimeoutMs,
        },
      });
      this.logger.log(`Device registered: ${device.deviceId}`);
      return;
    }

    if (result.message.type === 'device.heartbeat') {
      const { envelope } = result.message;
      const heartbeat = this.registry.heartbeat(
        client,
        envelope.deviceId,
        envelope.payload,
      );
      if (!heartbeat) {
        this.rejectUnregistered(client, envelope.messageId);
      }
      return;
    }

    if (
      !this.registry.isRegisteredClient(
        client,
        result.message.envelope.deviceId,
      )
    ) {
      this.rejectUnregistered(client, result.message.envelope.messageId);
      return;
    }

    if (result.message.type === 'command.ack') {
      const acknowledged = await this.commands?.acknowledge(
        client,
        result.message.envelope,
      );
      if (acknowledged === 'connection_mismatch') {
        this.sendProtocolError(
          client,
          'conflict',
          'Command acknowledgement is unknown, expired, or belongs to another connection.',
          result.message.envelope.messageId,
        );
      }
      return;
    }

    if (result.message.type === 'session.sync') {
      const requested = (result.message.envelope.payload as Record<string, unknown>)
        .autoApproveEnabled;
      if (typeof requested === 'boolean') {
        const updated = await this.sessions.setAutoApprove(
          result.message.envelope.sessionId!,
          requested,
          result.message.envelope.deviceId,
        );
        if (!updated) {
          this.sendProtocolError(
            client,
            'unknown_session',
            'Session does not exist for this device.',
            result.message.envelope.messageId,
            result.message.envelope.sessionId,
          );
          return;
        }
      }
      await this.sendSessionWatermark(client, result.message.envelope);
      return;
    }

    if (result.message.type === 'session.history.list') {
      const { envelope } = result.message;
      const cursor = envelope.payload.cursor === undefined
        ? undefined : parseHistoryCursor(envelope.payload.cursor);
      if (envelope.payload.cursor !== undefined && !cursor) {
        this.sendProtocolError(
          client, 'invalid_message', 'Invalid session history cursor.',
          envelope.messageId,
        );
        return;
      }
      const records = await this.sessions.listCopilotHistoryForDevice(
        envelope.deviceId, cursor, HISTORY_LIST_LIMIT + 1,
      );
      const hasMore = records.length > HISTORY_LIST_LIMIT;
      const page = records.slice(0, HISTORY_LIST_LIMIT);
      this.sendEnvelope<SessionHistoryListedPayload>(client, {
        type: 'session.history.listed',
        protocolVersion: '2',
        messageId: randomUUID(),
        deviceId: envelope.deviceId,
        sentAt: new Date().toISOString(),
        payload: {
          sessions: page.map((session) => ({
            id: session.id,
            workspaceId: session.workspaceId,
            toolKey: session.toolKey,
            displayName: session.displayName,
            runtimeMode: 'acp',
            status: session.status,
            startedAt: session.startedAt,
            updatedAt: session.updatedAt,
          })),
          hasMore,
          relatedMessageId: envelope.messageId,
          ...(hasMore ? { nextCursor: encodeHistoryCursor(page[page.length - 1]!) } : {}),
        },
      });
      return;
    }

    if (result.message.type === 'session.history.request') {
      const { envelope } = result.message;
      const sessionId = envelope.sessionId!;
      const session = await this.sessions.findOwnedSession(envelope.deviceId, sessionId);
      if (!session || session.toolKey !== 'copilot' || session.runtimeMode !== 'acp') {
        this.sendProtocolError(
          client, 'unknown_session', 'Session does not exist for this device.',
          envelope.messageId, sessionId,
        );
        return;
      }
      const limit = envelope.payload.limit ?? HISTORY_EVENT_LIMIT;
      const records = await this.sessions.listEventsBefore(
        sessionId, envelope.payload.beforeSeq, limit + 1,
      );
      if (!records) {
        this.sendProtocolError(
          client, 'unknown_session', 'Session does not exist for this device.',
          envelope.messageId, sessionId,
        );
        return;
      }
      let bytes = 0;
      const events = [];
      for (const event of records.slice(-limit).reverse()) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (bytes + size > HISTORY_EVENT_BYTES) break;
        bytes += size;
        events.push(event);
      }
      if (events.length === 0 && records.length > 0) {
        this.sendProtocolError(
          client, 'conflict', 'History event exceeds the maximum response size.',
          envelope.messageId, sessionId,
        );
        return;
      }
      this.sendEnvelope<SessionHistoryPayload>(client, {
        type: 'session.history',
        protocolVersion: '2',
        messageId: randomUUID(),
        deviceId: envelope.deviceId,
        sessionId,
        sentAt: new Date().toISOString(),
        payload: {
          events: events.reverse(),
          hasMore: records.length > events.length,
          relatedMessageId: envelope.messageId,
        },
      });
      return;
    }

    return this.handleSessionEvent(client, result.message);
  }

  private isPublicGateway(): boolean {
    return this.constructor.name === 'PublicClientGateway';
  }

  private async handleSessionEvent(
    client: WebSocket,
    message: Exclude<
      ValidClientMessage,
      { type: 'device.register' | 'device.heartbeat' | 'command.ack' | 'session.sync' | 'session.history.list' | 'session.history.request' }
    >,
  ): Promise<void> {
    const { envelope } = message;
    try {
      const result =
        message.type === 'workspace.registered'
          ? await this.sessions.registerWorkspace(
              envelope.deviceId,
              message.envelope.payload,
            )
          : message.type === 'session.started'
            ? await this.sessions.registerSession(
                envelope.deviceId,
                envelope.sessionId!,
                message.envelope.payload,
              )
            : message.type === 'session.ended'
              ? await this.sessions.finishReportedSession(
                  envelope.deviceId,
                  envelope.sessionId!,
                  message.envelope.payload,
                )
            : message.type === 'terminal.output'
              ? await this.sessions.appendTerminalOutput(
                envelope.deviceId,
                envelope.sessionId!,
                envelope.seq!,
                message.envelope.payload,
              )
              : await this.sessions.appendToolEvent(
                  envelope.deviceId,
                  envelope.sessionId!,
                  envelope.seq!,
                  message.envelope.payload,
                );

      if (result.status === 'error') {
        this.sendProtocolError(
          client,
          result.code,
          result.detail,
          envelope.messageId,
          envelope.sessionId,
          result.expectedSeq,
        );
      } else if (message.type === 'session.started') {
        await this.sendSessionWatermark(client, envelope);
      }

    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to handle ${message.type}: ${detail}`);
      this.sendProtocolError(
        client,
        'internal_error',
        'Failed to persist client event.',
        envelope.messageId,
        envelope.sessionId,
      );
    }
  }

  private async sendSessionWatermark(
    client: WebSocket,
    envelope: Pick<Envelope<unknown>, 'deviceId' | 'sessionId' | 'messageId'>,
  ): Promise<void> {
    const sessionId = envelope.sessionId!;
    const session = await this.sessions.findOwnedSession(envelope.deviceId, sessionId);
    if (!session) {
      this.sendProtocolError(
        client,
        'unknown_session',
        'Session does not exist for this device.',
        envelope.messageId,
        sessionId,
      );
      return;
    }
    this.sendEnvelope<SessionSyncedPayload & { autoApproveEnabled: boolean }>(client, {
      type: 'session.synced',
      protocolVersion: '2',
      messageId: randomUUID(),
      deviceId: envelope.deviceId,
      sessionId,
      sentAt: new Date().toISOString(),
      payload: {
        lastAcceptedSeq: session.stateVersion,
        autoApproveEnabled: session.autoApproveEnabled,
      },
    });
  }

  private rejectUnregistered(client: WebSocket, messageId: string): void {
    this.sendProtocolError(
      client,
      'unknown_device',
      'Register this connection before sending device events.',
      messageId,
    );
    client.close(1008, 'unregistered or mismatched device');
  }

  private sendProtocolError(
    client: WebSocket,
    code: ProtocolErrorCode,
    message: string,
    relatedMessageId?: string,
    sessionId?: string,
    expectedSeq?: number,
  ): void {
    const deviceId = this.registry.getDeviceId(client) ?? 'unregistered';
    this.sendEnvelope<ProtocolErrorPayload>(client, {
      type: 'protocol.error',
      protocolVersion: '2',
      messageId: randomUUID(),
      deviceId,
      ...(sessionId ? { sessionId } : {}),
      sentAt: new Date().toISOString(),
      payload: {
        code,
        message: message.slice(0, 2_048),
        ...(relatedMessageId ? { relatedMessageId } : {}),
        ...(expectedSeq ? { expectedSeq } : {}),
      },
    });
  }

  private sendEnvelope<TPayload>(
    client: WebSocket,
    envelope: Envelope<TPayload>,
  ): void {
    try {
      client.send(JSON.stringify({ event: 'message', data: envelope }));
    } catch {
      this.logger.warn(`Failed to send ${envelope.type} to ${envelope.deviceId}`);
    }
  }
}
