import { Module } from '@nestjs/common';
import { ClientAuthModule } from './client-auth/client-auth.module';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { BrowserProtocolValidator } from './realtime/browser-protocol-validator';
import { ClientGateway } from './realtime/client.gateway';
import { CommandRelayService } from './realtime/command-relay.service';
import { ProtocolValidator } from './realtime/protocol-validator';
import { PublicClientGateway } from './realtime/public-client.gateway';
import { SessionsModule } from './sessions/sessions.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    DatabaseModule.forRoot(),
    DevicesModule,
    SessionsModule,
    NotificationsModule,
    ClientAuthModule,
  ],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    PublicClientGateway,
    BrowserGateway,
    BrowserProtocolValidator,
    ProtocolValidator,
    CommandRelayService,
  ],
})
export class AppModule {}
