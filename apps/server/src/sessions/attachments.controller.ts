import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';

@Controller('api/sessions')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/attachments')
  capabilities(@Param('id') id: string) { return this.attachments.capabilities(id); }

  @Post(':id/attachments')
  transfer(@Param('id') id: string, @Body() body: unknown) {
    return this.attachments.transfer(id, body);
  }
}
