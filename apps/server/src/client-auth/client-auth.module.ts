import { Module } from '@nestjs/common';
import { ClientAuthRepository } from './client-auth.repository';
import { ClientConnectionAuthorizations } from './client-connection-authorizations';
import {
  CLIENT_AUTH_OPTIONS,
  CLIENT_AUTH_STORE,
  ClientAuthService,
  type ClientAuthOptions,
} from './client-auth.service';
import { ClientPairingsController } from './client-pairings.controller';
import { ClientApprovalsController } from './client-approvals.controller';
import { CloudflareAccessVerifier } from './cloudflare-access-verifier';
import { DeviceCredentialsController } from './device-credentials.controller';
import { DeviceCredentialsService } from './device-credentials.service';
import { ClientAuthRateLimiter } from './client-auth-rate-limiter';

@Module({
  controllers: [
    ClientPairingsController,
    ClientApprovalsController,
    DeviceCredentialsController,
  ],
  providers: [
    ClientAuthRepository,
    ClientConnectionAuthorizations,
    CloudflareAccessVerifier,
    DeviceCredentialsService,
    ClientAuthRateLimiter,
    ClientAuthService,
    { provide: CLIENT_AUTH_STORE, useExisting: ClientAuthRepository },
    {
      provide: CLIENT_AUTH_OPTIONS,
      useFactory: (): ClientAuthOptions => ({
        publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3007',
        credentialLifetimeMs: readOptionalLifetime(),
      }),
    },
  ],
  exports: [ClientAuthService, ClientConnectionAuthorizations],
})
export class ClientAuthModule {}

function readOptionalLifetime(): number | null {
  const raw = process.env.CLIENT_CREDENTIAL_LIFETIME_MS;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}