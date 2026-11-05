import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const CONTROLLER_AUTH_STORE = Symbol('CONTROLLER_AUTH_STORE');
export const CONTROLLER_AUTH_CLOCK = Symbol('CONTROLLER_AUTH_CLOCK');
export const CONTROLLER_PERMISSIONS = ['sessions.read', 'turns.write', 'approvals.resolve', 'user-input.resolve'] as const;
export type ControllerPairingStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'consumed';

export interface ControllerPairing {
  id: string;
  installationId: string;
  deviceName: string;
  appVersion: string;
  deviceCodeHash: string;
  status: ControllerPairingStatus;
  deviceIds: string[];
  approvedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ControllerCredential {
  id: string;
  installationId: string;
  deviceName: string;
  secretHash: string;
  deviceIds: string[];
  approvedBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type ControllerExchange =
  | { status: 'issued'; record: ControllerCredential }
  | { status: 'authorization_pending' | 'access_denied' | 'expired_token' | 'invalid_request' | 'cancelled' };

export interface ControllerAuthStore {
  hasPairing(id: string): Promise<boolean>;
  create(record: ControllerPairing): Promise<void>;
  pending(now: Date): Promise<ControllerPairing[]>;
  decide(id: string, decision: 'approved' | 'denied', approvedBy: string, deviceIds: string[], now: Date): Promise<boolean>;
  exchange(id: string, deviceCodeHash: string, credential: ControllerCredential, cancel: boolean, now: Date): Promise<ControllerExchange>;
  findCredential(id: string): Promise<ControllerCredential | undefined>;
  listCredentials(): Promise<ControllerCredential[]>;
  touch(id: string, now: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<boolean>;
}

export interface ControllerAuthorization {
  role: 'controller';
  credentialId: string;
  installationId: string;
  deviceIds: string[];
  permissions: readonly string[];
  expiresAt: null;
}

@Injectable()
export class ControllerAuthService {
  constructor(
    @Inject(CONTROLLER_AUTH_STORE) private readonly store: ControllerAuthStore,
    @Optional() @Inject(CONTROLLER_AUTH_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: { installationId: string; deviceName: string; appVersion: string }) {
    const now = this.now();
    const deviceCode = randomBytes(32).toString('base64url');
    const pairing: ControllerPairing = {
      id: randomUUID(), ...input, deviceCodeHash: controllerDigest(deviceCode), status: 'pending',
      deviceIds: [], approvedBy: null, createdAt: now, expiresAt: new Date(now.getTime() + 600_000),
    };
    await this.store.create(pairing);
    return { role: 'controller' as const, pairingId: pairing.id, deviceCode, expiresIn: 600, pollInterval: 3 };
  }

  async pending() {
    return (await this.store.pending(this.now())).map(({ deviceCodeHash: _secret, ...summary }) => summary);
  }

  ownsPairing(id: string) { return this.store.hasPairing(id); }

  decide(id: string, decision: 'approve' | 'deny', approvedBy: string, deviceIds: string[]) {
    return this.store.decide(id, decision === 'approve' ? 'approved' : 'denied', approvedBy, [...new Set(deviceIds)], this.now());
  }

  async exchange(id: string, deviceCode: string, cancel = false) {
    const secret = randomBytes(32).toString('base64url');
    const credential: ControllerCredential = {
      id: randomUUID(), installationId: '', deviceName: '', secretHash: controllerDigest(secret),
      deviceIds: [], approvedBy: '', createdAt: this.now(), lastUsedAt: null, revokedAt: null,
    };
    const result = await this.store.exchange(id, controllerDigest(deviceCode), credential, cancel, this.now());
    if (result.status !== 'issued') return { role: 'controller' as const, status: result.status };
    return {
      role: 'controller' as const, status: 'issued' as const,
      credential: `tr_controller_${result.record.id}.${secret}`, expiresAt: null,
    };
  }

  async validate(header: string | undefined): Promise<ControllerAuthorization | undefined> {
    const match = /^Bearer tr_controller_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return undefined;
    const record = await this.store.findCredential(match[1]);
    if (!record || record.revokedAt || !controllerDigestEqual(record.secretHash, controllerDigest(match[2]))) return undefined;
    await this.store.touch(record.id, this.now());
    return {
      role: 'controller', credentialId: record.id, installationId: record.installationId,
      deviceIds: record.deviceIds, permissions: CONTROLLER_PERMISSIONS, expiresAt: null,
    };
  }

  async list() {
    return (await this.store.listCredentials()).map(({ secretHash: _secret, ...record }) => ({ ...record, expiresAt: null }));
  }

  async isActive(id: string) {
    const record = await this.store.findCredential(id);
    return !!record && !record.revokedAt;
  }

  revoke(id: string) { return this.store.revoke(id, this.now()); }
}

export function controllerDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function controllerDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}