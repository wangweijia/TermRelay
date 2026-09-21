import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { ClientAuthService, type ClientPairingRecord } from './client-auth.service';
import { CloudflareAccessVerifier } from './cloudflare-access-verifier';

@Controller('api/client-approvals')
export class ClientApprovalsController {
  constructor(
    private readonly auth: ClientAuthService,
    private readonly access: CloudflareAccessVerifier,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async find(
    @Query('code') code: string | undefined,
    @Headers('cf-access-jwt-assertion') assertion: string | undefined,
  ): Promise<PairingSummary> {
    await this.access.verify(assertion);
    const pairing = await this.auth.findPairing(parseCode(code));
    if (!pairing) throw new NotFoundException('pairing not found');
    return summarize(pairing);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async decide(
    @Body() input: unknown,
    @Headers('cf-access-jwt-assertion') assertion: string | undefined,
  ): Promise<PairingSummary> {
    const identity = await this.access.verify(assertion);
    const body = parseDecision(input);
    const pairing = body.decision === 'approve'
      ? await this.auth.approvePairing(body.code, identity.email ?? identity.subject)
      : await this.auth.denyPairing(body.code, identity.email ?? identity.subject);
    if (!pairing) throw new NotFoundException('pending pairing not found');
    return summarize(pairing);
  }
}

interface PairingSummary {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  status: ClientPairingRecord['status'];
  createdAt: string;
  expiresAt: string;
}

function summarize(pairing: ClientPairingRecord): PairingSummary {
  return {
    deviceId: pairing.deviceId,
    deviceName: pairing.deviceName,
    appVersion: pairing.appVersion,
    status: pairing.status,
    createdAt: pairing.createdAt.toISOString(),
    expiresAt: pairing.expiresAt.toISOString(),
  };
}

function parseCode(code: unknown): string {
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i.test(code)) {
    throw new BadRequestException('invalid user code');
  }
  return code;
}

function parseDecision(input: unknown): { code: string; decision: 'approve' | 'deny' } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('request body must be an object');
  }
  const body = input as Record<string, unknown>;
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    throw new BadRequestException('decision must be approve or deny');
  }
  return { code: parseCode(body.code), decision: body.decision };
}