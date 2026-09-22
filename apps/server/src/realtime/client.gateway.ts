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

    return this.handleSessionEvent(client, result.message);
  }

  private isPublicGateway(): boolean {
    return this.constructor.name === 'PublicClientGateway';
  }

  private async handleSessionEvent(
    client: WebSocket,
    message: Exclude<
      ValidClientMessage,
      { type: 'device.register' | 'device.heartbeat' | 'command.ack' | 'session.sync' }
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
