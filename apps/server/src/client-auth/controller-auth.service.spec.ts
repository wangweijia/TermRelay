import assert from 'node:assert/strict';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import WebSocket from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ClientAuthService } from './client-auth.service';
import { ClientAuthWsAdapter } from './client-auth-ws.adapter';
import { ClientPairingsController } from './client-pairings.controller';
import { ClientConnectionAuthorizations } from './client-connection-authorizations';
import { ClientAuthRateLimiter } from './client-auth-rate-limiter';
import { ControllerManagementController } from './controller-management.controller';
import { ControllerConnections } from './controller-connections';
import { DevicesService } from '../devices/devices.service';
import { SessionsService } from '../sessions/sessions.service';
import { PublicClientGateway } from '../realtime/public-client.gateway';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { ProtocolValidator } from '../realtime/protocol-validator';
import {
  ControllerAuthService, controllerDigestEqual,
  type ControllerAuthStore, type ControllerCredential, type ControllerExchange, type ControllerPairing,
} from './controller-auth.service';

class MemoryControllerStore implements ControllerAuthStore {
  async hasPairing(id: string) { return this.pairings.has(id); }
  pairings = new Map<string, ControllerPairing>();
  credentials = new Map<string, ControllerCredential>();
  async create(record: ControllerPairing) { this.pairings.set(record.id, record); }
  async pending(now: Date) { return [...this.pairings.values()].filter(record => record.status === 'pending' && record.expiresAt > now); }
  async decide(id: string, decision: 'approved' | 'denied', approvedBy: string, deviceIds: string[], now: Date) {
    const record = this.pairings.get(id);
    if (!record || record.status !== 'pending' || record.expiresAt <= now) return false;
    Object.assign(record, { status: decision, approvedBy, deviceIds });
    return true;
  }
  async exchange(id: string, hash: string, credential: ControllerCredential, cancel: boolean, now: Date): Promise<ControllerExchange> {
    const record = this.pairings.get(id);
    if (!record || !controllerDigestEqual(record.deviceCodeHash, hash)) return { status: 'invalid_request' };
    if (record.status === 'consumed') return { status: 'invalid_request' };
    if (record.expiresAt <= now) return { status: 'expired_token' };
    if (record.status === 'denied' || record.status === 'cancelled') return { status: 'access_denied' };
    if (cancel) { record.status = 'cancelled'; return { status: 'cancelled' }; }
    if (record.status === 'pending') return { status: 'authorization_pending' };
    Object.assign(credential, { installationId: record.installationId, deviceName: record.deviceName, deviceIds: record.deviceIds, approvedBy: record.approvedBy });
    this.credentials.set(credential.id, credential);
    record.status = 'consumed';
    return { status: 'issued', record: credential };
  }
  async findCredential(id: string) { return this.credentials.get(id); }
  async listCredentials() { return [...this.credentials.values()]; }
  async touch(id: string, now: Date) { const record = this.credentials.get(id); if (record) record.lastUsedAt = now; }
  async revoke(id: string, now: Date) { const record = this.credentials.get(id); if (!record) return false; record.revokedAt ??= now; return true; }
}

function fixture() {
  const store = new MemoryControllerStore();
  let now = new Date('2026-11-05T00:00:00Z');
  const service = new ControllerAuthService(store, () => now);
  return { store, service, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}

const input = { installationId: 'installation-a', deviceName: 'CardputerZero', appVersion: '0.1.0' };

test('controller pairing hides secrets and exchanges once into a perpetual role-bound credential', async () => {
  const { service, store, advance } = fixture();
  const pairing = await service.create(input);
  assert.equal(pairing.role, 'controller');
  assert.equal('userCode' in pairing, false);
  assert.equal('verificationURL' in pairing, false);
  assert.notEqual(store.pairings.get(pairing.pairingId)?.deviceCodeHash, pairing.deviceCode);
  assert.equal('deviceCodeHash' in (await service.pending())[0]!, false);
  assert.equal((await service.exchange(pairing.pairingId, pairing.deviceCode)).status, 'authorization_pending');
  assert.equal(await service.decide(pairing.pairingId, 'approve', 'owner', ['mac-a', 'mac-a']), true);
  const result = await service.exchange(pairing.pairingId, pairing.deviceCode);
  assert.equal(result.status, 'issued');
  assert.ok('credential' in result);
  assert.equal(result.expiresAt, null);
  assert.equal((await service.exchange(pairing.pairingId, pairing.deviceCode)).status, 'invalid_request');
  advance(400 * 86_400_000);
  const authorization = await service.validate(`Bearer ${result.credential}`);
  assert.deepEqual(authorization?.deviceIds, ['mac-a']);
  assert.equal(authorization?.expiresAt, null);
  assert.equal(await service.validate(`Bearer ${result.credential.replace('tr_controller_', 'tr_device_')}`), undefined);
  assert.equal('secretHash' in (await service.list())[0]!, false);
  assert.ok(authorization);
  assert.equal(await service.revoke(authorization.credentialId), true);
  assert.equal(await service.validate(`Bearer ${result.credential}`), undefined);
});

test('cancelled, denied, expired and wrong-secret pairings cannot issue credentials', async () => {
  for (const action of ['cancel', 'deny', 'expire', 'wrong-secret'] as const) {
    const { service, store, advance } = fixture();
    const pairing = await service.create(input);
    if (action === 'cancel') assert.equal((await service.exchange(pairing.pairingId, pairing.deviceCode, true)).status, 'cancelled');
    if (action === 'deny') await service.decide(pairing.pairingId, 'deny', 'owner', []);
    if (action === 'expire') advance(600_001);
    if (action !== 'wrong-secret') assert.equal(await service.decide(pairing.pairingId, 'approve', 'owner', ['mac-a']), false);
    assert.notEqual((await service.exchange(pairing.pairingId, action === 'wrong-secret' ? 'invalid' : pairing.deviceCode)).status, 'issued');
    assert.equal(store.credentials.size, 0);
  }
});

async function serverFixture() {
  const { service, store } = fixture();
  @Module({
    controllers: [ClientPairingsController, ControllerManagementController],
    providers: [
      { provide: ControllerAuthService, useValue: service }, ControllerConnections,
      { provide: ClientAuthService, useValue: {
        createPairing: async () => ({ deviceCode: 'legacy-private', userCode: 'ABCD-EFGH', verificationURL: 'https://example.com/client/authorize' }),
        exchangePairing: async () => ({ status: 'authorization_pending' }),
        validateCredential: async () => ({ ok: false, reason: 'invalid' }),
      } },
      ClientAuthRateLimiter, ClientConnectionAuthorizations, DeviceConnectionRegistry, ProtocolValidator,
      { provide: SessionsService, useValue: {} },
      { provide: DevicesService, useValue: { list: async () => [{ id: 'mac-a', name: 'Development Mac', status: 'online' }] } },
      PublicClientGateway,
    ],
  })
  class Harness {}
  const app = await NestFactory.create<NestFastifyApplication>(Harness, new FastifyAdapter(), { logger: false });
  app.useWebSocketAdapter(new ClientAuthWsAdapter(app));
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const request = async (path: string, body?: unknown, overrides?: Record<string, string>) => {
    const response = await fetch(origin + path, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'Content-Type': 'application/json', origin, 'X-TermRelay-Settings': '1', ...overrides },
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { app, origin, request, service, store, registry: app.get(DeviceConnectionRegistry) };
}

test('shared HTTP and WSS authorize controllers without registering execution devices and revoke live sockets', { timeout: 15_000 }, async () => {
  const harness = await serverFixture();
  const { request, origin, registry } = harness;
  let socket: WebSocket | undefined;
  try {
    const legacy = await request('/api/client-pairings', { deviceId: 'legacy-mac', deviceName: 'Mac', appVersion: '1' });
    assert.equal(legacy.body.userCode, 'ABCD-EFGH');
    assert.equal((await request('/api/client-pairings', { ...input, role: 'unknown' })).status, 400);
    const created = await request('/api/client-pairings', { ...input, role: 'controller' });
    assert.equal(created.status, 201);
    const pairing = created.body as { pairingId: string; deviceCode: string };
    const pending = await request('/api/controller-approvals');
    assert.equal(pending.body.length, 1);
    assert.equal('deviceCodeHash' in pending.body[0], false);
    const decision = { pairingId: pairing.pairingId, decision: 'approve', deviceIds: ['mac-a'] };
    assert.equal((await request('/api/controller-approvals', decision, { origin: 'https://attacker.example' })).status, 403);
    assert.equal((await request('/api/controller-approvals', { ...decision, deviceIds: [] })).status, 400);
    assert.equal((await request('/api/controller-approvals', { ...decision, deviceIds: ['unknown'] })).status, 400);
    assert.equal((await request('/api/controller-approvals', decision)).status, 201);
    assert.equal((await request('/api/client-pairings/token', { ...pairing, role: 'device' })).status, 400);
    const exchange = await request('/api/client-pairings/token', pairing);
    assert.equal(exchange.body.status, 'issued');
    assert.equal(exchange.body.expiresAt, null);
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/client-public', { headers: { Authorization: `Bearer ${exchange.body.credential}` } });
    const ready = once(socket, 'message');
    const [frame] = await ready;
    const connected = JSON.parse(String(frame));
    assert.equal(connected.type, 'controller.connected');
    assert.equal(connected.payload.role, 'controller');
    assert.deepEqual(connected.payload.deviceIds, ['mac-a']);
    assert.deepEqual(registry.listDevices(), []);
    const rejected = once(socket, 'message');
    socket.send(JSON.stringify({ event: 'message', data: {
      type: 'device.register', protocolVersion: '2', messageId: randomUUID(), deviceId: input.installationId,
      sentAt: new Date().toISOString(), payload: { name: 'forged executor', appVersion: '1', platform: 'linux', tools: ['shell'] },
    } }));
    assert.equal(JSON.parse(String((await rejected)[0])).type, 'protocol.error');
    assert.deepEqual(registry.listDevices(), []);
    const me = once(socket, 'message');
    socket.send(JSON.stringify({ event: 'message', data: { type: 'controller.me.get', protocolVersion: '2', messageId: randomUUID(), deviceId: input.installationId, sentAt: new Date().toISOString(), payload: {} } }));
    assert.equal(JSON.parse(String((await me)[0])).type, 'controller.connected');
    const credential = (await request('/api/controller-credentials')).body[0];
    assert.equal('secretHash' in credential, false);
    const revoked = once(socket, 'message');
    const closed = once(socket, 'close');
    assert.equal((await request(`/api/controller-credentials/${credential.id}/revoke`, {})).status, 201);
    assert.equal(JSON.parse(String((await revoked)[0])).type, 'controller.authorization-revoked');
    assert.equal((await closed)[0], 4003);
    await harness.app.get(PublicClientGateway).handleMessage(socket, {
      type: 'device.register', protocolVersion: '2', messageId: randomUUID(), deviceId: 'late-forged-device',
      sentAt: new Date().toISOString(), payload: { name: 'late executor', appVersion: '1', platform: 'linux', tools: ['shell'] },
    });
    assert.deepEqual(registry.listDevices(), []);
    const rejectedSocket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/client-public', { headers: { Authorization: `Bearer ${exchange.body.credential}` } });
    const error = once(rejectedSocket, 'error');
    assert.match(String((await error)[0]), /401/);
  } finally { socket?.terminate(); await harness.app.close(); }
});

test('native probe pairs, restores a permanent credential and observes live revocation', { skip: !process.env.TERMRELAY_NATIVE_PROBE, timeout: 50_000 }, async () => {
  const harness = await serverFixture();
  const directory = await mkdtemp(join(tmpdir(), 'termrelay-native-'));
  const children: ReturnType<typeof spawn>[] = [];
  const start = (mode: string) => {
    const child = spawn(process.env.TERMRELAY_NATIVE_PROBE!, [harness.origin, directory, mode], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
    children.push(child);
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', data => { stdout += String(data); });
    child.stderr?.on('data', data => { stderr += String(data); });
    const completion = once(child, 'exit');
    const line = (expected: string) => new Promise<void>((resolve, reject) => {
      if (stdout.includes(expected)) { resolve(); return; }
      const onData = () => { if (stdout.includes(expected)) { child.stdout?.off('data', onData); resolve(); } };
      child.stdout?.on('data', onData);
      void completion.then(() => { child.stdout?.off('data', onData); if (!stdout.includes(expected)) reject(new Error(`Native probe did not reach ${expected}: ${stderr}`)); });
    });
    return { completion, line, stderr: () => stderr };
  };
  try {
    const initial = start('connect');
    await initial.line('WAITING');
    const pending = await harness.request('/api/controller-approvals');
    assert.equal(pending.body.length, 1);
    assert.equal((await harness.request('/api/controller-approvals', { pairingId: pending.body[0].id, decision: 'approve', deviceIds: ['mac-a'] })).status, 201);
    await initial.line('CONNECTED 1');
    assert.equal((await initial.completion)[0], 0, initial.stderr());
    const saved = JSON.parse(await readFile(join(directory, 'authorization.json'), 'utf8'));
    assert.match(saved.credential, /^tr_controller_/);
    const restored = start('revoke');
    await restored.line('CONNECTED 1');
    assert.equal((await harness.request('/api/controller-approvals')).body.length, 0);
    const credential = (await harness.request('/api/controller-credentials')).body[0];
    await harness.request(`/api/controller-credentials/${credential.id}/revoke`, {});
    await restored.line('REVOKED');
    assert.equal((await restored.completion)[0], 0, restored.stderr());
    assert.equal(JSON.parse(await readFile(join(directory, 'authorization.json'), 'utf8')).credential, '');
    assert.deepEqual(harness.registry.listDevices(), []);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await harness.app.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('native controller heartbeats distinguish healthy idle sockets from missing application replies', {
  skip: !process.env.TERMRELAY_NATIVE_PROBE, timeout: 150_000, concurrency: true,
}, async context => {
  const run = async (respond: boolean) => {
    const harness = await serverFixture();
    const directory = await mkdtemp(join(tmpdir(), 'termrelay-native-heartbeat-'));
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const pairing = await harness.service.create(input);
      await harness.service.decide(pairing.pairingId, 'approve', 'owner', ['mac-a']);
      const issued = await harness.service.exchange(pairing.pairingId, pairing.deviceCode);
      assert.ok('credential' in issued);
      await writeFile(join(directory, 'authorization.json'), JSON.stringify({
        version: 1, installationId: input.installationId, origin: harness.origin, credential: issued.credential,
      }), { mode: 0o600 });

      // Retain the real server's Ping/Pong heartbeat in both cases. Only the
      // application response is suppressed to simulate an unresponsive handler.
      const connections = harness.app.get(ControllerConnections);
      const message = connections.message.bind(connections);
      let queries = 0;
      connections.message = async (socket, envelope) => {
        if ((envelope as { type?: string })?.type === 'controller.me.get') queries++;
        if (respond) await message(socket, envelope);
      };
      child = spawn(process.env.TERMRELAY_NATIVE_PROBE!, [harness.origin, directory, respond ? 'idle' : 'timeout'], {
        env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
      });
      const completion = once(child, 'exit');
      let stdout = '', stderr = '';
      child.stdout?.on('data', data => { stdout += String(data); });
      child.stderr?.on('data', data => { stderr += String(data); });
      timer = setTimeout(() => child?.kill(), 140_000);
      assert.equal((await completion)[0], 0, stderr);
      assert.match(stdout, respond ? /IDLE_OK/ : /HEARTBEAT_TIMEOUT/);
      assert.equal((stdout.match(/CONNECTED /g) ?? []).length, 1);
      assert.ok(queries >= (respond ? 3 : 2), `Expected application heartbeats, received ${queries}`);
      assert.deepEqual(harness.registry.listDevices(), []);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) child.kill();
      await harness.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  await Promise.all([
    context.test('stays connected for 90 seconds while idle', () => run(true)),
    context.test('retries when application replies stop despite server Ping/Pong', () => run(false)),
  ]);
});
