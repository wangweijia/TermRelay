import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SessionStartService } from './session-start.service';

@Controller('api/session-starts')
export class SessionStartController {
  constructor(private readonly starts: SessionStartService) {}

  @Get('targets')
  targets() { return this.starts.targets(); }

  @Post()
  create(@Body() body: unknown) { return this.starts.create(body); }

  @Get(':id')
  get(@Param('id') id: string) { return this.starts.get(id); }
}
