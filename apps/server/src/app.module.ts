import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { BrowserProtocolValidator } from './realtime/browser-protocol-validator';
import { ClientGateway } from './realtime/client.gateway';
import { ProtocolValidator } from './realtime/protocol-validator';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [DatabaseModule.forRoot(), DevicesModule, SessionsModule],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    BrowserGateway,
    BrowserProtocolValidator,
    ProtocolValidator,
  ],
})
export class AppModule {}
