import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ShortcutsService } from './shortcuts.service';
import type { ShortcutRecord, ShortcutRunRecord } from './shortcuts.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Controller('api/shortcuts')
export class ShortcutsController {
  constructor(private readonly shortcuts: ShortcutsService) {}

  @Get()
  list(): Promise<ShortcutRecord[]> {
    return this.shortcuts.list();
  }

  @Get('runs')
  listRuns(@Query('limit') rawLimit?: string): Promise<ShortcutRunRecord[]> {
    if (rawLimit !== undefined && !/^[1-9]\d*$/u.test(rawLimit)) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 100) {
      throw new BadRequestException('limit must be an integer between 1 and 100');
    }
    return this.shortcuts.listRuns(limit);
  }

  @Post(':id/runs')
  start(@Param('id') id: string, @Body() body: unknown): Promise<ShortcutRunRecord> {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown> : undefined;
    if (!UUID.test(id) || !record || Object.keys(record).length !== 1 || !UUID.test(String(record.runId ?? ''))) {
      throw new BadRequestException('shortcut id and runId must be UUIDs');
    }
    return this.shortcuts.start(id, record.runId as string);
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string): Promise<ShortcutRunRecord> {
    if (!UUID.test(runId)) throw new BadRequestException('runId must be a UUID');
    const run = await this.shortcuts.getRun(runId);
    if (!run) throw new NotFoundException('shortcut run not found');
    return run;
  }

  @Post('runs/:runId/cancel')
  cancel(@Param('runId') runId: string): Promise<ShortcutRunRecord> {
    if (!UUID.test(runId)) throw new BadRequestException('runId must be a UUID');
    return this.shortcuts.cancel(runId);
  }
}
