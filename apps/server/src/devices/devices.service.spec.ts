import assert from 'node:assert/strict';
import test from 'node:test';
import type WebSocket from 'ws';
import {
  DeviceConnectionRegistry,
  type DeviceSnapshot,
} from '../realtime/device-connection.registry';
import type { DeviceRecord, DeviceRepository } from './device.repository';
import { DevicesService } from './devices.service';

test('exposes live devices when database is disabled', async () => {
  const registry = new DeviceConnectionRegistry();
  const repository = new FakeDeviceRepository(false);
  const service = new DevicesService(
    registry,
    repository as unknown as DeviceRepository,
  );
  service.onModuleInit();

  const client = {} as WebSocket;
  registry.connect(client, 1_000);
  registry.register(client, 'device-a', registration(), 2_000);

  const devices = await service.list();
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.id, 'device-a');
  assert.equal(devices[0]?.status, 'connected');
  await service.onModuleDestroy();
});

test('overlays live presence on persisted device records', async () => {
  const registry = new DeviceConnectionRegistry();
  const repository = new FakeDeviceRepository(true);
  repository.records.push(record('device-a', 'offline'));
  const service = new DevicesService(
    registry,
    repository as unknown as DeviceRepository,
  );
  service.onModuleInit();

  const client = {} as WebSocket;
  registry.connect(client, 1_000);
  registry.register(client, 'device-a', registration(), 2_000);

  const devices = await service.list();
  assert.equal(devices[0]?.status, 'connected');
  assert.equal(devices[0]?.createdAt, new Date(500).toISOString());
  await service.onModuleDestroy();
});

test('serializes persistence updates for the same device', async () => {
  const registry = new DeviceConnectionRegistry();
  const repository = new DelayedDeviceRepository();
  const service = new DevicesService(
    registry,
    repository as unknown as DeviceRepository,
  );
  service.onModuleInit();

  const client = {} as WebSocket;
  registry.connect(client, 1_000);
  registry.register(client, 'device-a', registration(), 2_000);
  registry.disconnect(client, 3_000);

  await service.list();
  assert.deepEqual(repository.presenceWrites, ['online', 'offline']);
  await service.onModuleDestroy();
});

function registration() {
  return {
    name: 'Development Mac',
    appVersion: '0.1.0',
    platform: 'macOS' as const,
    tools: ['codex'],
  };
}

function record(id: string, status: DeviceRecord['status']): DeviceRecord {
  return {
    id,
    name: 'Persisted Mac',
    status,
    appVersion: '0.1.0',
    platform: 'macOS',
    tools: ['codex'],
    activeSessionCount: 0,
    registeredAt: new Date(500).toISOString(),
    lastSeenAt: new Date(500).toISOString(),
    createdAt: new Date(500).toISOString(),
    updatedAt: new Date(500).toISOString(),
  };
}

class FakeDeviceRepository {
  readonly records: DeviceRecord[] = [];

  constructor(readonly enabled: boolean) {}

  async persist(_snapshot: DeviceSnapshot): Promise<void> {}

  async list(): Promise<DeviceRecord[]> {
    return [...this.records];
  }

  async findById(id: string): Promise<DeviceRecord | undefined> {
    return this.records.find((item) => item.id === id);
  }
}

class DelayedDeviceRepository extends FakeDeviceRepository {
  readonly presenceWrites: string[] = [];

  constructor() {
    super(true);
  }

  override async persist(snapshot: DeviceSnapshot): Promise<void> {
    if (snapshot.presence === 'online') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.presenceWrites.push(snapshot.presence);
  }
}
