import assert from 'node:assert/strict';
import test from 'node:test';
import { NotFoundException } from '@nestjs/common';
import type { DeviceRecord } from './device.repository';
import { DevicesController } from './devices.controller';
import type { DevicesService } from './devices.service';

test('lists devices from the service', async () => {
  const expected = record();
  const controller = new DevicesController(
    serviceStub({ list: async () => [expected] }),
  );

  assert.deepEqual(await controller.list(), [expected]);
});

test('returns a device by id', async () => {
  const expected = record();
  const controller = new DevicesController(
    serviceStub({ findById: async () => expected }),
  );

  assert.equal(await controller.findById(expected.id), expected);
});

test('returns not found for an unknown device', async () => {
  const controller = new DevicesController(
    serviceStub({ findById: async () => undefined }),
  );

  await assert.rejects(
    () => controller.findById('unknown'),
    (error: unknown) => error instanceof NotFoundException,
  );
});

function serviceStub(
  overrides: Partial<Pick<DevicesService, 'list' | 'findById'>>,
): DevicesService {
  return {
    list: async () => [],
    findById: async () => undefined,
    ...overrides,
  } as DevicesService;
}

function record(): DeviceRecord {
  const timestamp = new Date(1_000).toISOString();
  return {
    id: 'device-a',
    name: 'Development Mac',
    status: 'offline',
    appVersion: '0.1.0',
    platform: 'macOS',
    tools: ['codex'],
    activeSessionCount: 0,
    registeredAt: timestamp,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
