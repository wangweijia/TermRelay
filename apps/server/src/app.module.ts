import { CommandRelayModule } from './realtime/command-relay.module';
import { Module } from '@nestjs/common';
import { ClientAuthModule } from './client-auth/client-auth.module';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { BrowserProtocolValidator } from './realtime/browser-protocol-validator';
import { ClientGateway } from './realtime/client.gateway';
import { ProtocolValidator } from './realtime/protocol-validator';
import { PublicClientGateway } from './realtime/public-client.gateway';
import { SessionsModule } from './sessions/sessions.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ShortcutsModule } from './shortcuts/shortcuts.module';
import { AIModule } from './ai/ai.module';

@Module({
  imports: [
    DatabaseModule.forRoot(),
    CommandRelayModule,
    DevicesModule,
    SessionsModule,
    NotificationsModule,
    ClientAuthModule,
    ShortcutsModule,
    AIModule,
  ],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    PublicClientGateway,
    BrowserGateway,
    BrowserProtocolValidator,
    ProtocolValidator,
  ],
})
export class AppModule {}
