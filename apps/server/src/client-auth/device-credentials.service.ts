import { Injectable } from '@nestjs/common';
import type { Envelope } from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import { ClientAuthService, type DeviceCredentialRecord } from './client-auth.service';
import { ClientConnectionAuthorizations } from './client-connection-authorizations';

interface AuthorizationRevokedPayload {
  reason: 'revoked' | 'expired' | 'device_disabled';
  revokedAt: string;
}

@Injectable()
export class DeviceCredentialsService {
  constructor(
    private readonly auth: ClientAuthService,
    private readonly connections: ClientConnectionAuthorizations,
  ) {}

  list(): Promise<DeviceCredentialRecord[]> {
    return this.auth.listCredentials();
  }

  async revoke(id: string): Promise<DeviceCredentialRecord | undefined> {
    const credential = await this.auth.revokeCredential(id);
    if (!credential?.revokedAt) return credential;

    const envelope: Envelope<AuthorizationRevokedPayload> = {
      type: 'client.authorization-revoked',
      protocolVersion: '2',
      messageId: randomUUID(),
      deviceId: credential.deviceId,
      sentAt: credential.revokedAt.toISOString(),
      payload: { reason: 'revoked', revokedAt: credential.revokedAt.toISOString() },
    };
    for (const socket of this.connections.socketsForCredential(id)) {
      try {
        socket.send(JSON.stringify({ event: 'message', data: envelope }));
      } finally {
        socket.close(4003, 'authorization revoked');
      }
    }
    return credential;
  }
}