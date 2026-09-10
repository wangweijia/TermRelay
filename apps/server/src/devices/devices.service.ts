import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  DeviceConnectionRegistry,
  type DeviceSnapshot,
} from '../realtime/device-connection.registry';
import { DeviceRepository, type DeviceRecord } from './device.repository';

@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicesService.name);
  private readonly persistence = new Map<string, Promise<void>>();
  private unsubscribe?: () => void;

  constructor(
    private readonly registry: DeviceConnectionRegistry,
    private readonly repository: DeviceRepository,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.registry.subscribe((snapshot) => {
      this.enqueuePersistence(snapshot);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.waitForPersistence();
  }

  async list(): Promise<DeviceRecord[]> {
    if (!this.repository.enabled) {
      return this.registry.listDevices().map(snapshotToTransientRecord);
    }

    await this.waitForPersistence();
    const persisted = await this.repository.list();
    return mergeLiveSnapshots(persisted, this.registry.listDevices());
  }

  async findById(id: string): Promise<DeviceRecord | undefined> {
    await this.waitForPersistence(id);
    const live = this.registry.getDevice(id);
    if (live) {
      const persisted = this.repository.enabled
        ? await this.repository.findById(id)
        : undefined;
      return mergeOne(persisted, live);
    }
    return this.repository.findById(id);
  }

  private enqueuePersistence(snapshot: DeviceSnapshot): void {
    const previous = this.persistence.get(snapshot.deviceId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.repository.persist(snapshot))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to persist device ${snapshot.deviceId}: ${detail}`);
      })
      .finally(() => {
        if (this.persistence.get(snapshot.deviceId) === operation) {
          this.persistence.delete(snapshot.deviceId);
        }
      });
    this.persistence.set(snapshot.deviceId, operation);
  }

  private async waitForPersistence(deviceId?: string): Promise<void> {
    if (deviceId) {
      await this.persistence.get(deviceId);
      return;
    }
    await Promise.all(this.persistence.values());
  }
}

function mergeLiveSnapshots(
  persisted: DeviceRecord[],
  live: DeviceSnapshot[],
): DeviceRecord[] {
  const records = new Map(persisted.map((record) => [record.id, record]));
  for (const snapshot of live) {
    records.set(snapshot.deviceId, mergeOne(records.get(snapshot.deviceId), snapshot));
  }
  return [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function mergeOne(
  persisted: DeviceRecord | undefined,
  snapshot: DeviceSnapshot,
): DeviceRecord {
  const now = snapshot.lastSeenAt;
  return {
    id: snapshot.deviceId,
    name: snapshot.name,
    status:
      snapshot.presence === 'offline' ? 'offline' : snapshot.connectionState,
    appVersion: snapshot.appVersion,
    platform: snapshot.platform,
    tools: [...snapshot.tools],
    activeSessionCount: snapshot.activeSessionCount,
    registeredAt: snapshot.registeredAt,
    lastSeenAt: snapshot.lastSeenAt,
    ...(snapshot.disconnectedAt
      ? { disconnectedAt: snapshot.disconnectedAt }
      : {}),
    createdAt: persisted?.createdAt ?? snapshot.registeredAt,
    updatedAt: now,
  };
}

function snapshotToTransientRecord(snapshot: DeviceSnapshot): DeviceRecord {
  return mergeOne(undefined, snapshot);
}
