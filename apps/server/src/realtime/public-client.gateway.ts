import { WebSocketGateway } from '@nestjs/websockets';
import { ClientGateway } from './client.gateway';

@WebSocketGateway({ path: '/ws/client-public' })
export class PublicClientGateway extends ClientGateway {}