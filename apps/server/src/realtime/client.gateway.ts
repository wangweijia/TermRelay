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
} from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
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
  ) {}

  handleConnection(client: WebSocket): void {
    this.registry.connect(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.registry.disconnect(client);
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
      const device = this.registry.register(
        client,
        envelope.deviceId,
        envelope.payload,
      );
      this.sendEnvelope<DeviceRegisteredPayload>(client, {
        type: 'device.registered',
        protocolVersion: '1',
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
      if (!await this.commands?.acknowledge(client, result.message.envelope)) {
        this.sendProtocolError(
          client,
          'conflict',
          'Command acknowledgement is unknown, expired, or belongs to another connection.',
          result.message.envelope.messageId,
        );
      }
      return;
    }

    return this.handleSessionEvent(client, result.message);
  }

  private async handleSessionEvent(
    client: WebSocket,
    message: Exclude<
      ValidClientMessage,
      { type: 'device.register' | 'device.heartbeat' | 'command.ack' }
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
            : await this.sessions.appendTerminalOutput(
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
        );
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to handle ${message.type}: ${detail}`);
      this.sendProtocolError(
        client,
        'internal_error',
        'Failed to persist client event.',
        envelope.messageId,
      );
    }
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
  ): void {
    const deviceId = this.registry.getDeviceId(client) ?? 'unregistered';
    this.sendEnvelope<ProtocolErrorPayload>(client, {
      type: 'protocol.error',
      protocolVersion: '1',
      messageId: randomUUID(),
      deviceId,
      sentAt: new Date().toISOString(),
      payload: {
        code,
        message: message.slice(0, 2_048),
        ...(relatedMessageId ? { relatedMessageId } : {}),
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
