import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import type {
  PendingApprovalRecord,
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

  @Get('approvals/pending')
  listPendingApprovals(): Promise<PendingApprovalRecord[]> {
    return this.sessions.listPendingApprovals();
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
    @Query('beforeSeq') rawBeforeSeq?: string,
  ): Promise<SessionEventRecord[]> {
    if (rawAfterSeq !== undefined && rawBeforeSeq !== undefined) {
      throw new BadRequestException('afterSeq and beforeSeq are mutually exclusive');
    }
    const limit = parseInteger(rawLimit, 200, 1, 1_000);
    const events = rawAfterSeq !== undefined
      ? await this.sessions.listEvents(
          id,
          parseInteger(rawAfterSeq, -1, -1, Number.MAX_SAFE_INTEGER),
          limit,
        )
      : await this.sessions.listEventsBefore(
          id,
          rawBeforeSeq === undefined
            ? undefined
            : parseInteger(rawBeforeSeq, 0, 0, Number.MAX_SAFE_INTEGER),
          limit,
        );
    if (!events) throw new NotFoundException('session not found');
    return events;
  }

  @Delete(':id')
  async deleteFinished(
    @Param('id') id: string,
    @Query('purge') rawPurge?: string,
  ): Promise<{ deleted: true; purged: boolean }> {
    const purge = parseBoolean(rawPurge, false);
    const result = await this.sessions.deleteFinished(id, purge);
    if (result === 'not_found') throw new NotFoundException('session not found');
    if (result === 'not_finished') {
      throw new ConflictException('only finished sessions can be deleted');
    }
    return { deleted: true, purged: purge };
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException('query parameter must be true or false');
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
