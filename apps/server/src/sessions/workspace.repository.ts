import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { WorkspaceRegisteredPayload } from '@termrelay/contracts';
import { DataSource, Repository } from 'typeorm';
import { WorkspaceEntity } from './workspace.entity';

export type WorkspaceWriteResult = 'accepted' | 'conflict';

@Injectable()
export class WorkspaceRepository {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  get enabled(): boolean {
    return this.dataSource !== undefined;
  }

  async register(
    deviceId: string,
    payload: WorkspaceRegisteredPayload,
  ): Promise<WorkspaceWriteResult> {
    if (!this.dataSource) return 'conflict';
    const existing = await this.repository.findOneBy({ id: payload.workspaceId });
    if (existing && existing.deviceId !== deviceId) return 'conflict';

    await this.repository.save(
      this.repository.create({
        ...existing,
        id: payload.workspaceId,
        deviceId,
        displayName: payload.displayName,
        available: payload.available,
        remoteStartAllowed: payload.remoteStartAllowed,
      }),
    );
    return 'accepted';
  }

  findById(id: string): Promise<WorkspaceEntity | null> {
    if (!this.dataSource) return Promise.resolve(null);
    return this.repository.findOneBy({ id });
  }

  private get repository(): Repository<WorkspaceEntity> {
    if (!this.dataSource) throw new Error('Database is disabled.');
    return this.dataSource.getRepository(WorkspaceEntity);
  }
}
