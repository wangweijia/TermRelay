import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Req, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AiJobRequest, AiConversationRequest, AiTurnRequest } from '@termrelay/contracts';
import { isIP } from 'node:net';
import { AIService } from './ai.service';
import { AIRepository } from './ai.repository';
import type { AIResource } from './ai.entity';

export function isLAN(address: string): boolean {
  const ip = address.replace(/^::ffff:/i,'').split('%')[0]!;
  if (!isIP(ip)) return false;
  return ip === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)
    || /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

@Controller('api/ai/v1')
export class AIController {
  constructor(private readonly ai: AIService, private readonly repo: AIRepository) {}
  private async key(req: FastifyRequest, authorization?: string) {
    if (!this.repo.persistent) throw new ServiceUnavailableException('ai_requires_database');
    if (!isLAN(req.ip) || req.headers['cf-ray'] || req.headers['cf-access-jwt-assertion'] || req.headers['x-forwarded-for']) throw new ForbiddenException('lan_only');
    return this.ai.authenticate(authorization);
  }
  private view(r: AIResource) {
    // Persisted historical JSON may contain fields removed from the current API.
    const {input,output,fingerprint,profile,profileVersion,...result} = r as AIResource & {profile?:unknown;profileVersion?:unknown};
    const identifiers = r.kind === 'job' ? {jobId:r.id}:r.kind === 'conversation' ? {conversationId:r.id}:{turnId:r.id,conversationId:r.sessionId};
    return {...result,...identifiers,actualProvider:r.provider,elapsedMs:Math.max(0,Date.parse(r.finishedAt ?? new Date().toISOString())-Date.parse(r.createdAt)),links:{self:r.kind === 'turn' ? `/api/ai/v1/conversations/${r.sessionId}/turns/${r.id}`:`/api/ai/v1/${r.kind === 'job' ? 'jobs':'conversations'}/${r.id}`}};
  }
  @Get('targets') async targets(@Req() req: FastifyRequest, @Headers('authorization') auth?: string) { return this.ai.targets(await this.key(req,auth)); }
  @Post('jobs') @HttpCode(202) async job(@Req() req: FastifyRequest, @Body() body: AiJobRequest, @Headers('idempotency-key') idem: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.create(await this.key(req,auth),'job',body,idem)); }
  @Post('conversations') @HttpCode(202) async conversation(@Req() req: FastifyRequest, @Body() body: AiConversationRequest, @Headers('idempotency-key') idem: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.create(await this.key(req,auth),'conversation',body,idem)); }
  @Get('jobs/:id') async getJob(@Req() req: FastifyRequest, @Param('id') id: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.get(await this.key(req,auth),id,'job')); }
  @Get('conversations/:id') async getConversation(@Req() req: FastifyRequest, @Param('id') id: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.get(await this.key(req,auth),id,'conversation')); }
  @Post('conversations/:id/turns') @HttpCode(202) async turn(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: AiTurnRequest, @Headers('idempotency-key') idem: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.turn(await this.key(req,auth),id,body,idem)); }
  @Get('conversations/:id/turns/:turnId') async getTurn(@Req() req: FastifyRequest, @Param('id') id: string, @Param('turnId') turnId: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.get(await this.key(req,auth),turnId,'turn',id)); }
  @Post('jobs/:id/cancel') @HttpCode(202) async cancelJob(@Req() req: FastifyRequest, @Param('id') id: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.cancel(await this.key(req,auth),id,'job')); }
  @Post('conversations/:id/turns/:turnId/cancel') @HttpCode(202) async cancelTurn(@Req() req: FastifyRequest, @Param('id') id: string, @Param('turnId') turnId: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.cancel(await this.key(req,auth),turnId,'turn',id)); }
  @Delete('conversations/:id') @HttpCode(202) async close(@Req() req: FastifyRequest, @Param('id') id: string, @Headers('authorization') auth?: string) { return this.view(await this.ai.close(await this.key(req,auth),id)); }
}
