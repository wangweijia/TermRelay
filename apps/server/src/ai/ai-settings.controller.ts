import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AIRepository } from './ai.repository';
import { AISettingsService } from './ai-settings.service';
import { AIService } from './ai.service';
import { DevicesService } from '../devices/devices.service';

// Browser management shares the Web's existing Access/Tunnel boundary, not AI API keys.
@Controller('api/settings/ai')
export class AISettingsController {
  constructor(private readonly settings: AISettingsService, private readonly repo: AIRepository, private readonly ai: AIService, private readonly devices: DevicesService) {}
  private guard(req: FastifyRequest, write = false, requireDatabase = true) {
    if (req.headers.authorization) throw new ForbiddenException('project_key_not_admin');
    // Non-simple header forces cross-origin browsers to preflight; Server does not enable CORS.
    if (write && (req.headers['x-termrelay-settings'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site')) throw new ForbiddenException('same_origin_required');
    if (req.headers.origin) {
      try { if (new URL(String(req.headers.origin)).host !== req.headers.host) throw new Error(); }
      catch { throw new ForbiddenException('same_origin_required'); }
    }
    if (requireDatabase && !this.repo.persistent) throw new ServiceUnavailableException('ai_requires_database');
  }
  @Get('targets') @Header('Cache-Control','no-store') async targets(@Req() req: FastifyRequest) {
    this.guard(req,false,false);
    const live = new Map(this.ai.availableTargets().map(target => [target.deviceId,target]));
    return (await this.devices.list()).map(device => ({
      deviceId:device.id,name:device.name,online:live.get(device.id)?.online ?? false,
      providers:live.get(device.id)?.providers ?? [],
    }));
  }
  @Get() @Header('Cache-Control','no-store') async overview(@Req() req: FastifyRequest) {
    this.guard(req);
    return {keys:await this.settings.list()};
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
