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
import { DeviceCredentialsController } from './device-credentials.controller';
import { DeviceCredentialsService } from './device-credentials.service';
import { ClientAuthRateLimiter } from './client-auth-rate-limiter';
import { ControllerAuthService, CONTROLLER_AUTH_STORE } from './controller-auth.service';
import { ControllerAuthRepository } from './controller-auth.repository';
import { ControllerConnections } from './controller-connections';
import { ControllerManagementController } from './controller-management.controller';
import { DevicesModule } from '../devices/devices.module';
import { SessionsModule } from '../sessions/sessions.module';
import { CommandRelayModule } from '../realtime/command-relay.module';
import { ControllerConversationService } from './controller-conversation.service';

@Module({
  imports: [DevicesModule, SessionsModule, CommandRelayModule],
  controllers: [
    ClientPairingsController,
    ClientApprovalsController,
    DeviceCredentialsController,
    ControllerManagementController,
  ],
  providers: [
    ClientAuthRepository,
    ClientConnectionAuthorizations,
    DeviceCredentialsService,
    ClientAuthRateLimiter,
    ClientAuthService,
    ControllerAuthService,
    ControllerAuthRepository,
    ControllerConnections,
    ControllerConversationService,
    { provide: CONTROLLER_AUTH_STORE, useExisting: ControllerAuthRepository },
    { provide: CLIENT_AUTH_STORE, useExisting: ClientAuthRepository },
    {
      provide: CLIENT_AUTH_OPTIONS,
      useFactory: (): ClientAuthOptions => ({
        publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3007',
        credentialLifetimeMs: readOptionalLifetime(),
      }),
    },
  ],
  exports: [ClientAuthService, ClientConnectionAuthorizations, ControllerAuthService, ControllerConnections],
})
export class ClientAuthModule {}

function readOptionalLifetime(): number | null {
  const raw = process.env.CLIENT_CREDENTIAL_LIFETIME_MS;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
