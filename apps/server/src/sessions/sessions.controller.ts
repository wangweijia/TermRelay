import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type {
  SessionEventRecord,
  SessionRecord,
} from './session.repository';
import { SessionsService } from './sessions.service';

@Controller('api/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(): Promise<SessionRecord[]> {
    return this.sessions.list();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<SessionRecord> {
    const session = await this.sessions.findById(id);
    if (!session) throw new NotFoundException('session not found');
    return session;
  }

  @Get(':id/events')
  async listEvents(
    @Param('id') id: string,
    @Query('afterSeq') rawAfterSeq?: string,
    @Query('limit') rawLimit?: string,
  ): Promise<SessionEventRecord[]> {
    const afterSeq = parseInteger(rawAfterSeq, -1, -1, Number.MAX_SAFE_INTEGER);
    const limit = parseInteger(rawLimit, 200, 1, 1_000);
    const events = await this.sessions.listEvents(id, afterSeq, limit);
    if (!events) throw new NotFoundException('session not found');
    return events;
  }
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/u.test(value)) {
    throw new BadRequestException('query parameter must be an integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(
      `query parameter must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}
