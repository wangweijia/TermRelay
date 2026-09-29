import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import { FilePreviewService } from './file-preview.service';

@Controller('api/sessions')
export class FilePreviewController {
  constructor(private readonly previews: FilePreviewService) {}

  @Post(':id/file-preview')
  preview(@Param('id') id: string, @Body() body: unknown): Promise<{ name: string; content: string }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof (body as { path?: unknown }).path !== 'string') {
      throw new BadRequestException('body must contain only a file path');
    }
    return this.previews.preview(id, (body as { path: string }).path);
  }
}
