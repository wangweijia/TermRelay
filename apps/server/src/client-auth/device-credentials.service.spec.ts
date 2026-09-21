import assert from 'node:assert/strict';
import test from 'node:test';
import type WebSocket from 'ws';
import type { ClientAuthService, DeviceCredentialRecord } from './client-auth.service';
import { ClientConnectionAuthorizations } from './client-connection-authorizations';
import { DeviceCredentialsService } from './device-credentials.service';

test('persists revocation before notifying and closing active sockets', async () => {
  const calls: string[] = [];
  const revokedAt = new Date('2026-09-21T12:00:00.000Z');
  const credential: DeviceCredentialRecord = {
    id: 'credential-a',
    deviceId: 'device-a',
    secretHash: 'hash',
    approvedBy: 'owner@example.com',
    createdAt: new Date('2026-09-20T12:00:00.000Z'),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt,
  };
  const auth = {
    async revokeCredential(id: string) {
      assert.equal(id, credential.id);
      calls.push('persist');
      return credential;
    },
  } as ClientAuthService;
  const socket = {
    send(value: string) {
      calls.push('send');
      const message = JSON.parse(value) as { data: { type: string; deviceId: string } };
      assert.equal(message.data.type, 'client.authorization-revoked');
      assert.equal(message.data.deviceId, credential.deviceId);
    },
    close(code: number) {
      calls.push('close');
      assert.equal(code, 4003);
    },
  } as WebSocket;
  const connections = new ClientConnectionAuthorizations();
  connections.attach(socket, {
    credentialId: credential.id,
    deviceId: credential.deviceId,
    expiresAt: null,
  });
  const service = new DeviceCredentialsService(auth, connections);

  await service.revoke(credential.id);

  assert.deepEqual(calls, ['persist', 'send', 'close']);
});