import assert from 'node:assert/strict';
import test from 'node:test';
import { DataSource, In } from 'typeorm';
import { DeviceEntity } from './device.entity';
import { DeviceRepository } from './device.repository';

test('startup resets all active device states in a single update without touching offline devices', async (t) => {
  const dataSource = new DataSource({ type: 'mysql', entities: [DeviceEntity] });
  const update = t.mock.method(dataSource.getRepository(DeviceEntity), 'update', async () =>
    ({ affected: 3, raw: [], generatedMaps: [] }));
  await new DeviceRepository(dataSource).onModuleInit();
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0]?.arguments, [
    { status: In(['connected', 'degraded', 'connecting']) },
    { status: 'offline' },
  ]);
});

test('startup propagates device reset failures and supports a disabled database', async (t) => {
  const dataSource = new DataSource({ type: 'mysql', entities: [DeviceEntity] });
  const failure = new Error('reset failed');
  t.mock.method(dataSource.getRepository(DeviceEntity), 'update', async () => { throw failure; });
  await assert.rejects(new DeviceRepository(dataSource).onModuleInit(), failure);
  await new DeviceRepository().onModuleInit();
});
