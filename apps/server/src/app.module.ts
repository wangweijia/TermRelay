import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { BrowserGateway } from './realtime/browser.gateway';
import { ClientGateway } from './realtime/client.gateway';

@Module({
  imports: [DatabaseModule.forRoot()],
  controllers: [HealthController],
  providers: [ClientGateway, BrowserGateway],
})
export class AppModule {}
