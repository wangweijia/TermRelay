import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { BrowserProtocolValidator } from './realtime/browser-protocol-validator';
import { ClientGateway } from './realtime/client.gateway';
import { CommandRelayService } from './realtime/command-relay.service';
import { ProtocolValidator } from './realtime/protocol-validator';
import { SessionsModule } from './sessions/sessions.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [DatabaseModule.forRoot(), DevicesModule, SessionsModule, NotificationsModule],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    BrowserGateway,
    BrowserProtocolValidator,
    ProtocolValidator,
    CommandRelayService,
  ],
})
export class AppModule {}
