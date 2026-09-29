import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { WorkspaceRepository } from './workspace.repository';
import { FilePreviewController } from './file-preview.controller';
import { FilePreviewService } from './file-preview.service';

@Module({
  imports: [DevicesModule],
  controllers: [SessionsController, FilePreviewController],
  providers: [WorkspaceRepository, SessionRepository, SessionsService, FilePreviewService],
  exports: [SessionsService, FilePreviewService],
})
export class SessionsModule {}
