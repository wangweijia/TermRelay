import { Logger } from '@nestjs/common';
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
import { DeviceConnectionRegistry } from './device-connection.registry';
import { ProtocolValidator } from './protocol-validator';

@WebSocketGateway({ path: '/ws/client' })
export class ClientGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ClientGateway.name);

  constructor(
    private readonly validator: ProtocolValidator,
    private readonly registry: DeviceConnectionRegistry,
  ) {}

  handleConnection(client: WebSocket): void {
    this.registry.connect(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.registry.disconnect(client);
  }

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() input: unknown,
  ): void {
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

    const { envelope } = result.message;
    const heartbeat = this.registry.heartbeat(
      client,
      envelope.deviceId,
      envelope.payload,
    );
    if (!heartbeat) {
      this.sendProtocolError(
        client,
        'unknown_device',
        'Register this connection before sending heartbeats.',
        envelope.messageId,
      );
      client.close(1008, 'unregistered or mismatched device');
    }
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
