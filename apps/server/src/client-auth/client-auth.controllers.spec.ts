import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientApprovalsController } from './client-approvals.controller';
import type {
  ClientAuthService,
  ClientPairingRecord,
  DeviceCredentialRecord,
} from './client-auth.service';
import { DeviceCredentialsController } from './device-credentials.controller';
import type { DeviceCredentialsService } from './device-credentials.service';

const pairing: ClientPairingRecord = {
  id: 'pairing-a',
  deviceId: 'device-a',
  deviceName: 'Development Mac',
  appVersion: '0.1.0',
  deviceCodeHash: 'device-code-hash',
  userCodeHash: 'user-code-hash',
  status: 'pending',
  approvedBy: null,
  expiresAt: new Date('2026-09-22T01:10:00.000Z'),
  approvedAt: null,
  consumedAt: null,
  createdAt: new Date('2026-09-22T01:00:00.000Z'),
};

test('browser approval trusts Cloudflare edge authentication without JWT verification', async () => {
  let approvedBy: string | undefined;
  const auth = {
    async findPairing() {
      return pairing;
    },
    async approvePairing(_code: string, identity: string) {
      approvedBy = identity;
      return { ...pairing, status: 'approved' } as ClientPairingRecord;
    },
  } as unknown as ClientAuthService;
  const controller = new ClientApprovalsController(auth);

  assert.equal((await controller.find('ABCD-EFGH')).deviceId, pairing.deviceId);
  await controller.decide(
    { code: 'ABCD-EFGH', decision: 'approve' },
    ' owner@example.com ',
  );
  assert.equal(approvedBy, 'owner@example.com');
});

test('browser approval uses a stable fallback when Cloudflare omits the email header', async () => {
  let approvedBy: string | undefined;
  const auth = {
    async denyPairing(_code: string, identity: string) {
      approvedBy = identity;
      return { ...pairing, status: 'denied' } as ClientPairingRecord;
    },
  } as ClientAuthService;
  const controller = new ClientApprovalsController(auth);

  await controller.decide({ code: 'ABCD-EFGH', decision: 'deny' }, undefined);
  assert.equal(approvedBy, 'cloudflare-access-user');
});

test('credential management works without an application-level Access token', async () => {
  const credential: DeviceCredentialRecord = {
    id: 'credential-a',
    deviceId: 'device-a',
    secretHash: 'secret-hash',
    approvedBy: 'owner@example.com',
    createdAt: new Date('2026-09-22T01:00:00.000Z'),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  const service = {
    async list() {
      return [credential];
    },
    async revoke(id: string) {
      assert.equal(id, credential.id);
      return { ...credential, revokedAt: new Date('2026-09-22T02:00:00.000Z') };
    },
  } as DeviceCredentialsService;
  const controller = new DeviceCredentialsController(service);

  assert.equal((await controller.list())[0]?.deviceId, credential.deviceId);
  assert.equal((await controller.revoke(credential.id)).id, credential.id);
});
