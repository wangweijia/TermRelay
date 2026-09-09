import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Envelope } from '@termrelay/contracts';
import type WebSocket from 'ws';

@WebSocketGateway({ path: '/ws/client' })
export class ClientGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly clients = new Set<WebSocket>();

  handleConnection(client: WebSocket): void {
    this.clients.add(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
  }

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() message: Envelope,
  ): void {
    // The application router will validate and persist before fan-out.
    if (message.protocolVersion !== '1') {
      client.close(1002, 'unsupported protocol version');
    }
  }
}

