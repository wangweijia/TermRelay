import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { WorkspaceRepository } from './workspace.repository';
import { FilePreviewController } from './file-preview.controller';
import { FilePreviewService } from './file-preview.service';
import { SessionStartController } from './session-start.controller';
import { SessionStartService } from './session-start.service';
import { SessionStartRepository } from './session-start.repository';

@Module({
  imports: [DevicesModule],
  controllers: [AttachmentsController, SessionsController, FilePreviewController, SessionStartController],
  providers: [AttachmentsService, WorkspaceRepository, SessionRepository, SessionsService, FilePreviewService, SessionStartService, SessionStartRepository],
  exports: [AttachmentsService, SessionsService, FilePreviewService, SessionStartService],
})
export class SessionsModule {}
