import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DevicesService } from '../devices/devices.service';
import { ControllerAuthService } from './controller-auth.service';
import { ControllerConnections } from './controller-connections';

@Controller('api')
export class ControllerManagementController {
  constructor(private readonly auth: ControllerAuthService, private readonly connections: ControllerConnections, private readonly devices: DevicesService) {}

  @Get('controller-approvals')
  @Header('Cache-Control', 'no-store')
  pending() { return this.auth.pending(); }

  @Post('controller-approvals')
  @Header('Cache-Control', 'no-store')
  async decide(@Body() input: unknown, @Req() request: FastifyRequest, @Headers('cf-access-authenticated-user-email') email?: string) {
    requireControllerManagementOrigin(request);
    const body = record(input);
    if (typeof body.pairingId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.pairingId) || !['approve', 'deny'].includes(String(body.decision))) throw new BadRequestException('invalid decision');
    if (!Array.isArray(body.deviceIds) || body.deviceIds.length > 100 || body.deviceIds.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new BadRequestException('invalid deviceIds');
    const deviceIds = body.deviceIds as string[];
    if (body.decision === 'approve') {
      if (!deviceIds.length) throw new BadRequestException('select at least one device');
      const available = new Set((await this.devices.list()).map(device => device.id));
      if (deviceIds.some(id => !available.has(id))) throw new BadRequestException('unknown device');
    }
    const identity = email?.trim().slice(0, 320) || 'cloudflare-access-user';
    if (!await this.auth.decide(body.pairingId, body.decision as 'approve' | 'deny', identity, deviceIds)) throw new NotFoundException('pending pairing not found');
    return { updated: true };
  }

  @Get('controller-credentials')
  @Header('Cache-Control', 'no-store')
  list() { return this.auth.list(); }

  @Post('controller-credentials/:id/revoke')
  @Header('Cache-Control', 'no-store')
  async revoke(@Param('id') id: string, @Req() request: FastifyRequest) {
    requireControllerManagementOrigin(request);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BadRequestException('invalid credential');
    if (!await this.auth.revoke(id)) throw new NotFoundException('credential not found');
    this.connections.revoke(id);
    return { revoked: true };
  }
}

export function requireControllerManagementOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (request.headers['x-termrelay-settings'] !== '1' || request.headers['sec-fetch-site'] === 'cross-site' || typeof origin !== 'string') throw new ForbiddenException('same_origin_required');
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host !== request.headers.host) throw new Error('origin mismatch');
  } catch { throw new ForbiddenException('same_origin_required'); }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('invalid body');
  return input as Record<string, unknown>;
}