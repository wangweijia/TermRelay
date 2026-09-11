import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { DeviceSnapshot } from '../realtime/device-connection.registry';
import { DeviceEntity } from './device.entity';

export interface DeviceRecord {
  id: string;
  name: string;
  status: DeviceEntity['status'];
  appVersion: string | null;
  platform: 'macOS';
  tools: string[];
  activeSessionCount: number;
  registeredAt: string;
  lastSeenAt: string | null;
  disconnectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class DeviceRepository implements OnModuleInit {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  get enabled(): boolean {
    return this.dataSource !== undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.dataSource) return;
    await this.repository.update(
      { status: 'connected' },
      { status: 'offline' },
    );
    await this.repository.update(
      { status: 'degraded' },
      { status: 'offline' },
    );
    await this.repository.update(
      { status: 'connecting' },
      { status: 'offline' },
    );
  }

  async persist(snapshot: DeviceSnapshot): Promise<void> {
    if (!this.dataSource) return;

    const existing = await this.repository.findOneBy({ id: snapshot.deviceId });
    const entity = this.repository.create({
      ...existing,
      id: snapshot.deviceId,
      name: snapshot.name,
      status:
        snapshot.presence === 'offline'
          ? 'offline'
          : snapshot.connectionState,
      appVersion: snapshot.appVersion,
      lastSeenAt: new Date(snapshot.lastSeenAt),
      capabilities: {
        platform: snapshot.platform,
        tools: [...snapshot.tools],
        activeSessionCount: snapshot.activeSessionCount,
        registeredAt: snapshot.registeredAt,
        ...(snapshot.disconnectedAt
          ? { disconnectedAt: snapshot.disconnectedAt }
          : {}),
      },
    });
    await this.repository.save(entity);
  }

  async list(): Promise<DeviceRecord[]> {
    if (!this.dataSource) return [];
    const entities = await this.repository.find({
      order: { updatedAt: 'DESC' },
    });
    return entities.map(toRecord);
  }

  async findById(id: string): Promise<DeviceRecord | undefined> {
    if (!this.dataSource) return undefined;
    const entity = await this.repository.findOneBy({ id });
    return entity ? toRecord(entity) : undefined;
  }

  private get repository(): Repository<DeviceEntity> {
    if (!this.dataSource) throw new Error('Database is disabled.');
    return this.dataSource.getRepository(DeviceEntity);
  }
}

function toRecord(entity: DeviceEntity): DeviceRecord {
  return {
    id: entity.id,
    name: entity.name,
    status: entity.status,
    appVersion: entity.appVersion,
    platform: entity.capabilities.platform,
    tools: [...entity.capabilities.tools],
    activeSessionCount:
      entity.status === 'offline' ? 0 : entity.capabilities.activeSessionCount,
    registeredAt: entity.capabilities.registeredAt,
    lastSeenAt: entity.lastSeenAt?.toISOString() ?? null,
    ...(entity.capabilities.disconnectedAt
      ? { disconnectedAt: entity.capabilities.disconnectedAt }
      : {}),
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}
