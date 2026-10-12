import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeCredentials, activeKeys, availableTargets } from '../src/settings.ts';

test('only online devices publishing AI capabilities are listed, without mutating the snapshot', () => {
  const provider = { provider: 'codex', capacity: 4, workspaceEnabled: false };
  const targets = [
    { deviceId: 'b', name: 'B', online: true, providers: [provider] },
    { deviceId: 'offline', name: 'Offline', online: false, providers: [provider] },
    { deviceId: 'disabled', name: 'Disabled', online: true, providers: [] },
    { deviceId: 'a', name: 'A', online: true, providers: [provider] },
  ];
  assert.deepEqual(availableTargets(targets), [targets[3], targets[0]]);
  assert.equal(targets[0].deviceId, 'b');
  assert.deepEqual(availableTargets([]), []);
});

test('revoked keys disappear while legacy keys remain manageable for replacement', () => {
  const keys = [
    { id: 'current', revoked: false, legacy: false },
    { id: 'revoked', revoked: true, legacy: false },
    { id: 'legacy', revoked: false, legacy: true },
  ];
  assert.deepEqual(activeKeys(keys), [keys[0], keys[2]]);
  keys[0].revoked = true;
  assert.deepEqual(activeKeys(keys), [keys[2]]);
  assert.deepEqual(activeKeys([]), []);
});

test('Mac authorizations exclude revoked, expired and malformed expiration dates', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const base = { deviceId: 'mac', approvedBy: 'owner', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, revokedAt: null };
  const credentials = [
    { ...base, id: 'permanent', expiresAt: null },
    { ...base, id: 'valid', expiresAt: '2026-10-12T12:00:01Z' },
    { ...base, id: 'expired', expiresAt: '2026-10-12T11:59:59Z' },
    { ...base, id: 'boundary', expiresAt: '2026-10-12T12:00:00Z' },
    { ...base, id: 'revoked', expiresAt: null, revokedAt: '2026-10-11T00:00:00Z' },
    { ...base, id: 'invalid', expiresAt: 'invalid' },
  ];
  assert.deepEqual(activeCredentials(credentials, now), [credentials[0], credentials[1]]);
  assert.deepEqual(activeCredentials(credentials, now + 1000), [credentials[0]]);
  assert.deepEqual(activeCredentials([], now), []);
});
