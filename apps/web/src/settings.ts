import type { AiProviderCapability } from '@termrelay/contracts';

export interface ProjectKey {
  id: string;
  revoked: boolean;
  legacy: boolean;
}

export interface AITarget {
  deviceId: string;
  name: string;
  online: boolean;
  providers: AiProviderCapability[];
}

export interface ClientCredentialSummary {
  id: string;
  deviceId: string;
  approvedBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function availableTargets(targets: AITarget[]): AITarget[] {
  return targets.filter(target => target.online && target.providers.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function activeKeys(keys: ProjectKey[]): ProjectKey[] {
  return keys.filter(key => !key.revoked);
}

export function activeCredentials(credentials: ClientCredentialSummary[], now: number): ClientCredentialSummary[] {
  return credentials.filter(credential => !credential.revokedAt
    && (credential.expiresAt === null || Date.parse(credential.expiresAt) > now));
}
