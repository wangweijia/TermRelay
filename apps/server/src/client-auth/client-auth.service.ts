import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type ClientPairingStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'consumed'
  | 'expired';

export interface ClientPairingRecord {
  id: string;
  deviceId: string;
  deviceName: string;
  appVersion: string;
  deviceCodeHash: string;
  userCodeHash: string;
  status: ClientPairingStatus;
  approvedBy: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface DeviceCredentialRecord {
  id: string;
  deviceId: string;
  secretHash: string;
  approvedBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ClientAuthStore {
  createPairing(record: ClientPairingRecord): Promise<void>;
  findPairing(userCodeHash: string, now: Date): Promise<ClientPairingRecord | undefined>;
  approvePairing(userCodeHash: string, approvedBy: string, now: Date): Promise<ClientPairingRecord | undefined>;
  denyPairing(userCodeHash: string, approvedBy: string, now: Date): Promise<ClientPairingRecord | undefined>;
  exchangePairing(
    pairingId: string,
    deviceCodeHash: string,
    credential: DeviceCredentialRecord,
    now: Date,
  ): Promise<'issued' | 'pending' | 'denied' | 'expired' | 'consumed' | 'invalid'>;
  findCredential(id: string): Promise<DeviceCredentialRecord | undefined>;
  listCredentials(): Promise<DeviceCredentialRecord[]>;
  touchCredential(id: string, now: Date): Promise<void>;
  revokeCredential(id: string, now: Date): Promise<DeviceCredentialRecord | undefined>;
}

export interface CreatedClientPairing {
  pairingId: string;
  deviceCode: string;
  userCode: string;
  verificationURL: string;
  expiresIn: number;
  pollInterval: number;
}

export type PairingExchangeResult =
  | { status: 'issued'; credential: string; expiresAt: string | null }
  | { status: 'authorization_pending' | 'access_denied' | 'expired_token' | 'invalid_request' };

export type CredentialValidationResult =
  | { ok: true; credentialId: string; deviceId: string; expiresAt: Date | null }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'mismatch' };

export interface ClientAuthOptions {
  publicOrigin: string;
  pairingLifetimeMs?: number;
  pollIntervalSeconds?: number;
  credentialLifetimeMs?: number | null;
}

export const CLIENT_AUTH_STORE = Symbol('CLIENT_AUTH_STORE');
export const CLIENT_AUTH_OPTIONS = Symbol('CLIENT_AUTH_OPTIONS');
export const CLIENT_AUTH_CLOCK = Symbol('CLIENT_AUTH_CLOCK');

@Injectable()
export class ClientAuthService {
  private readonly pairingLifetimeMs: number;
  private readonly pollIntervalSeconds: number;
  private readonly credentialLifetimeMs: number | null;

  constructor(
    @Inject(CLIENT_AUTH_STORE)
    private readonly store: ClientAuthStore,
    @Inject(CLIENT_AUTH_OPTIONS)
    private readonly options: ClientAuthOptions,
    @Optional()
    @Inject(CLIENT_AUTH_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pairingLifetimeMs = options.pairingLifetimeMs ?? 10 * 60_000;
    this.pollIntervalSeconds = options.pollIntervalSeconds ?? 3;
    this.credentialLifetimeMs = options.credentialLifetimeMs ?? null;
  }

  async createPairing(input: {
    deviceId: string;
    deviceName: string;
    appVersion: string;
  }): Promise<CreatedClientPairing> {
    const createdAt = this.now();
    const pairingId = randomUUID();
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = makeUserCode();
    await this.store.createPairing({
      id: pairingId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      appVersion: input.appVersion,
      deviceCodeHash: digest(deviceCode),
      userCodeHash: digest(normalizeUserCode(userCode)),
      status: 'pending',
      approvedBy: null,
      expiresAt: new Date(createdAt.getTime() + this.pairingLifetimeMs),
      approvedAt: null,
      consumedAt: null,
      createdAt,
    });
    const verificationURL = new URL('/client/authorize', this.options.publicOrigin);
    verificationURL.searchParams.set('code', userCode);
    return {
      pairingId,
      deviceCode,
      userCode,
      verificationURL: verificationURL.toString(),
      expiresIn: Math.floor(this.pairingLifetimeMs / 1_000),
      pollInterval: this.pollIntervalSeconds,
    };
  }

  findPairing(userCode: string): Promise<ClientPairingRecord | undefined> {
    return this.store.findPairing(digest(normalizeUserCode(userCode)), this.now());
  }

  approvePairing(userCode: string, approvedBy: string): Promise<ClientPairingRecord | undefined> {
    return this.store.approvePairing(
      digest(normalizeUserCode(userCode)),
      approvedBy,
      this.now(),
    );
  }

  denyPairing(userCode: string, approvedBy: string): Promise<ClientPairingRecord | undefined> {
    return this.store.denyPairing(
      digest(normalizeUserCode(userCode)),
      approvedBy,
      this.now(),
    );
  }

  async exchangePairing(pairingId: string, deviceCode: string): Promise<PairingExchangeResult> {
    const now = this.now();
    const credentialId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const credential: DeviceCredentialRecord = {
      id: credentialId,
      deviceId: '',
      secretHash: digest(secret),
      approvedBy: '',
      createdAt: now,
      expiresAt: this.credentialLifetimeMs === null
        ? null
        : new Date(now.getTime() + this.credentialLifetimeMs),
      lastUsedAt: null,
      revokedAt: null,
    };
    const status = await this.store.exchangePairing(
      pairingId,
      digest(deviceCode),
      credential,
      now,
    );
    if (status === 'issued') {
      return {
        status: 'issued',
        credential: `tr_device_${credentialId}.${secret}`,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
      };
    }
    if (status === 'pending') return { status: 'authorization_pending' };
    if (status === 'denied') return { status: 'access_denied' };
    if (status === 'expired') return { status: 'expired_token' };
    return { status: 'invalid_request' };
  }

  async validateCredential(authorization: string | undefined): Promise<CredentialValidationResult> {
    if (!authorization) return { ok: false, reason: 'missing' };
    const match = /^Bearer tr_device_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match?.[1] || !match[2]) return { ok: false, reason: 'malformed' };
    const record = await this.store.findCredential(match[1]);
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.now();
    if (record.expiresAt && record.expiresAt <= now) return { ok: false, reason: 'expired' };
    if (!safeDigestEqual(record.secretHash, digest(match[2]))) {
      return { ok: false, reason: 'mismatch' };
    }
    await this.store.touchCredential(record.id, now);
    return {
      ok: true,
      credentialId: record.id,
      deviceId: record.deviceId,
      expiresAt: record.expiresAt,
    };
  }

  listCredentials(): Promise<DeviceCredentialRecord[]> {
    return this.store.listCredentials();
  }

  revokeCredential(id: string): Promise<DeviceCredentialRecord | undefined> {
    return this.store.revokeCredential(id, this.now());
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase().replaceAll('-', '');
}

function makeUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const characters = [...bytes].map((value) => alphabet[value % alphabet.length]);
  return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
}