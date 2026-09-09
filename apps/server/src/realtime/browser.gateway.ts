import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type WebSocket from 'ws';

@WebSocketGateway({ path: '/ws/web' })
export class BrowserGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly browsers = new Set<WebSocket>();

  handleConnection(client: WebSocket): void {
    // TODO: reject unless a verified Cloudflare Access identity is attached.
    this.browsers.add(client);
  }

  handleDisconnect(client: WebSocket): void {
    this.browsers.delete(client);
  }
}

