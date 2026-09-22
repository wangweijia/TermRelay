import { Controller, Get, Header, NotFoundException, Param, Post } from '@nestjs/common';
import type { DeviceCredentialRecord } from './client-auth.service';
import { DeviceCredentialsService } from './device-credentials.service';

interface CredentialSummary {
  id: string;
  deviceId: string;
  approvedBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

@Controller('api/client-credentials')
export class DeviceCredentialsController {
  constructor(private readonly credentials: DeviceCredentialsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(): Promise<CredentialSummary[]> {
    return (await this.credentials.list()).map(summarize);
  }

  @Post(':id/revoke')
  @Header('Cache-Control', 'no-store')
  async revoke(@Param('id') id: string): Promise<CredentialSummary> {
    const credential = await this.credentials.revoke(id);
    if (!credential) throw new NotFoundException('credential not found');
    return summarize(credential);
  }
}

function summarize(credential: DeviceCredentialRecord): CredentialSummary {
  return {
    id: credential.id,
    deviceId: credential.deviceId,
    approvedBy: credential.approvedBy,
    createdAt: credential.createdAt.toISOString(),
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
  };
}
