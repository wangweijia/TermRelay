import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { isLAN } from './ai.controller';
import { AIRepository } from './ai.repository';
import { AIService } from './ai.service';
import { AISettingsService } from './ai-settings.service';

// Browser management is a separate LAN-only boundary, not authorized by project API keys.
@Controller('api/settings/ai')
export class AISettingsController {
  constructor(private readonly settings: AISettingsService, private readonly ai: AIService, private readonly repo: AIRepository) {}
  private guard(req: FastifyRequest, write = false) {
    if (!isLAN(req.ip) || req.headers['cf-ray'] || req.headers['cf-access-jwt-assertion'] || req.headers['x-forwarded-for']) throw new ForbiddenException('lan_only');
    if (req.headers.authorization) throw new ForbiddenException('project_key_not_admin');
    // Non-simple header forces cross-origin browsers to preflight; Server does not enable CORS.
    if (write && (req.headers['x-termrelay-settings'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site')) throw new ForbiddenException('same_origin_required');
    if (req.headers.origin) {
      try { if (new URL(String(req.headers.origin)).host !== req.headers.host) throw new Error(); }
      catch { throw new ForbiddenException('same_origin_required'); }
    }
    if (!this.repo.persistent) throw new ServiceUnavailableException('ai_requires_database');
  }
  @Get() @Header('Cache-Control','no-store') async overview(@Req() req: FastifyRequest) {
    this.guard(req);
    return {keys:await this.settings.list(),targets:this.ai.configurationTargets()};
  }
  @Post('keys') @HttpCode(201) @Header('Cache-Control','no-store') create(@Req() req: FastifyRequest, @Body() body: unknown) {
    this.guard(req,true); return this.settings.create(body);
  }
  @Post('keys/:id/rotate') @HttpCode(201) @Header('Cache-Control','no-store') rotate(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.guard(req,true); return this.settings.rotate(id);
  }
  @Post('keys/:id/revoke') @HttpCode(200) @Header('Cache-Control','no-store') revoke(@Req() req: FastifyRequest, @Param('id') id: string) {
    this.guard(req,true); return this.settings.revoke(id);
  }
}
