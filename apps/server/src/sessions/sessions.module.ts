import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { WorkspaceRepository } from './workspace.repository';

@Module({
  imports: [DevicesModule],
  controllers: [SessionsController],
  providers: [WorkspaceRepository, SessionRepository, SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
