import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { ClientGateway } from './realtime/client.gateway';
import { DeviceConnectionRegistry } from './realtime/device-connection.registry';
import { ProtocolValidator } from './realtime/protocol-validator';

@Module({
  imports: [DatabaseModule.forRoot()],
  controllers: [HealthController],
  providers: [
    ClientGateway,
    BrowserGateway,
    DeviceConnectionRegistry,
    ProtocolValidator,
  ],
})
export class AppModule {}
