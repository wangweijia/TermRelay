import { BadRequestException, Body, Controller, Header, HttpException, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ClientAuthRateLimiter, clientAddress } from './client-auth-rate-limiter';
import { ClientAuthService, type PairingExchangeResult } from './client-auth.service';

@Controller('api/client-pairings')
export class ClientPairingsController {
  constructor(
    private readonly auth: ClientAuthService,
    private readonly rateLimiter: ClientAuthRateLimiter,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() input: unknown, @Req() request: FastifyRequest) {
    this.limit(request, 'create', 10);
    return this.auth.createPairing(parseCreatePairing(input));
  }

  @Post('token')
  @Header('Cache-Control', 'no-store')
  exchange(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
  ): Promise<PairingExchangeResult> {
    this.limit(request, 'exchange', 120);
    const body = parseExchangePairing(input);
    return this.auth.exchangePairing(body.pairingId, body.deviceCode);
  }

  private limit(request: FastifyRequest, action: string, maximum: number): void {
    const address = clientAddress(request.headers, request.ip);
    if (!this.rateLimiter.consume(`${action}:${address}`, maximum, 60_000)) {
      throw new HttpException('too many client authentication requests', 429);
    }
  }
}

function parseCreatePairing(input: unknown): {
  deviceId: string;
  deviceName: string;
  appVersion: string;
} {
  const body = object(input);
  return {
    deviceId: text(body.deviceId, 'deviceId', 128),
    deviceName: text(body.deviceName, 'deviceName', 128),
    appVersion: text(body.appVersion, 'appVersion', 64),
  };
}

function parseExchangePairing(input: unknown): { pairingId: string; deviceCode: string } {
  const body = object(input);
  return {
    pairingId: text(body.pairingId, 'pairingId', 36),
    deviceCode: text(body.deviceCode, 'deviceCode', 128),
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('request body must be an object');
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(
      `${name} must be a non-empty string up to ${maxLength} characters`,
    );
  }
  return value;
}