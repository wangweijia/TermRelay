import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { ClientGateway } from './realtime/client.gateway';

@Module({
  controllers: [HealthController],
  providers: [ClientGateway, BrowserGateway],
})
export class AppModule {}
