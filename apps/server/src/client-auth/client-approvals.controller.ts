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

const DEFAULT_APPROVER = 'cloudflare-access-user';

@Controller('api/client-approvals')
export class ClientApprovalsController {
  constructor(private readonly auth: ClientAuthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async find(@Query('code') code: string | undefined): Promise<PairingSummary> {
    const pairing = await this.auth.findPairing(parseCode(code));
    if (!pairing) throw new NotFoundException('pairing not found');
    return summarize(pairing);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async decide(
    @Body() input: unknown,
    @Headers('cf-access-authenticated-user-email') email: string | undefined,
  ): Promise<PairingSummary> {
    const body = parseDecision(input);
    const approvedBy = accessUser(email);
    const pairing = body.decision === 'approve'
      ? await this.auth.approvePairing(body.code, approvedBy)
      : await this.auth.denyPairing(body.code, approvedBy);
    if (!pairing) throw new NotFoundException('pending pairing not found');
    return summarize(pairing);
  }
}

function accessUser(email: string | undefined): string {
  const value = email?.trim();
  return value && value.length <= 320 ? value : DEFAULT_APPROVER;
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
