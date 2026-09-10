import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { DevicesModule } from './devices/devices.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { ClientGateway } from './realtime/client.gateway';
import { ProtocolValidator } from './realtime/protocol-validator';

@Module({
  imports: [DatabaseModule.forRoot(), DevicesModule],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    BrowserGateway,
    ProtocolValidator,
  ],
})
export class AppModule {}
