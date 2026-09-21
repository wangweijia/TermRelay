import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClientAuthService,
  type ClientAuthStore,
  type ClientPairingRecord,
  type DeviceCredentialRecord,
} from './client-auth.service';

test('creates an expiring pairing without storing plaintext codes', async () => {
  const store = new MemoryClientAuthStore();
  const now = new Date('2026-09-21T12:00:00.000Z');
  const service = makeService(store, now);

  const result = await service.createPairing({
    deviceId: 'device-a',
    deviceName: 'Development Mac',
    appVersion: '0.1.0',
  });

  assert.match(result.deviceCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(result.expiresIn, 600);
  assert.equal(result.pollInterval, 3);
  assert.equal(result.verificationURL, `https://termrelay.example/client/authorize?code=${result.userCode}`);
  assert.notEqual(store.pairings[0]?.deviceCodeHash, result.deviceCode);
  assert.notEqual(store.pairings[0]?.userCodeHash, result.userCode.replace('-', ''));
});

test('issues a non-expiring credential once after approval', async () => {
  const store = new MemoryClientAuthStore();
  const now = new Date('2026-09-21T12:00:00.000Z');
  const service = makeService(store, now);
  const pairing = await service.createPairing({
    deviceId: 'device-a',
    deviceName: 'Development Mac',
    appVersion: '0.1.0',
  });

  const pending = await service.exchangePairing(pairing.pairingId, pairing.deviceCode);
  assert.deepEqual(pending, { status: 'authorization_pending' });
  assert.ok(await service.approvePairing(pairing.userCode, 'user@example.com'));

  const issued = await service.exchangePairing(pairing.pairingId, pairing.deviceCode);
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') return;
  assert.equal(issued.expiresAt, null);
  assert.match(issued.credential, /^tr_device_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(store.credentials[0]?.deviceId, 'device-a');
  assert.equal(store.credentials[0]?.approvedBy, 'user@example.com');

  const repeated = await service.exchangePairing(pairing.pairingId, pairing.deviceCode);
  assert.deepEqual(repeated, { status: 'invalid_request' });
});

test('validates binding and rejects revoked credentials', async () => {
  const store = new MemoryClientAuthStore();
  const now = new Date('2026-09-21T12:00:00.000Z');
  const service = makeService(store, now);
  const pairing = await service.createPairing({
    deviceId: 'device-a',
    deviceName: 'Development Mac',
    appVersion: '0.1.0',
  });
  await service.approvePairing(pairing.userCode, 'user@example.com');
  const issued = await service.exchangePairing(pairing.pairingId, pairing.deviceCode);
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') return;

  const valid = await service.validateCredential(`Bearer ${issued.credential}`);
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.deviceId, 'device-a');
  await service.revokeCredential(valid.credentialId);
  assert.deepEqual(
    await service.validateCredential(`Bearer ${issued.credential}`),
    { ok: false, reason: 'revoked' },
  );
});

function makeService(store: MemoryClientAuthStore, now: Date): ClientAuthService {
  return new ClientAuthService(
    store,
    { publicOrigin: 'https://termrelay.example' },
    () => now,
  );
}

class MemoryClientAuthStore implements ClientAuthStore {
  readonly pairings: ClientPairingRecord[] = [];
  readonly credentials: DeviceCredentialRecord[] = [];

  async createPairing(record: ClientPairingRecord): Promise<void> {
    this.pairings.push(record);
  }

  async findPairing(userCodeHash: string, now: Date): Promise<ClientPairingRecord | undefined> {
    const pairing = [...this.pairings.values()].find(
      (candidate) => candidate.userCodeHash === userCodeHash,
    );
    if (pairing?.status === 'pending' && pairing.expiresAt <= now) pairing.status = 'expired';
    return pairing;
  }

  async approvePairing(
    userCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    const pairing = this.pairings.find((item) => item.userCodeHash === userCodeHash);
    if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= now) return undefined;
    pairing.status = 'approved';
    pairing.approvedBy = approvedBy;
    pairing.approvedAt = now;
    return pairing;
  }

  async denyPairing(
    userCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ClientPairingRecord | undefined> {
    const pairing = this.pairings.find((item) => item.userCodeHash === userCodeHash);
    if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= now) return undefined;
    pairing.status = 'denied';
    pairing.approvedBy = approvedBy;
    return pairing;
  }

  async exchangePairing(
    pairingId: string,
    deviceCodeHash: string,
    credential: DeviceCredentialRecord,
    now: Date,
  ): Promise<'issued' | 'pending' | 'denied' | 'expired' | 'consumed' | 'invalid'> {
    const pairing = this.pairings.find((item) => item.id === pairingId);
    if (!pairing || pairing.deviceCodeHash !== deviceCodeHash) return 'invalid';
    if (pairing.expiresAt <= now) return 'expired';
    if (pairing.status === 'pending') return 'pending';
    if (pairing.status === 'denied') return 'denied';
    if (pairing.status === 'consumed') return 'consumed';
    credential.deviceId = pairing.deviceId;
    credential.approvedBy = pairing.approvedBy!;
    this.credentials.push(credential);
    pairing.status = 'consumed';
    pairing.consumedAt = now;
    return 'issued';
  }

  async findCredential(id: string): Promise<DeviceCredentialRecord | undefined> {
    return this.credentials.find((item) => item.id === id);
  }

  async listCredentials(): Promise<DeviceCredentialRecord[]> {
    return [...this.credentials.values()];
  }

  async touchCredential(id: string, now: Date): Promise<void> {
    const credential = this.credentials.find((item) => item.id === id);
    if (credential) credential.lastUsedAt = now;
  }

  async revokeCredential(id: string, now: Date): Promise<DeviceCredentialRecord | undefined> {
    const credential = this.credentials.find((item) => item.id === id);
    if (credential) credential.revokedAt = now;
    return credential;
  }
}