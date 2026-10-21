import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { SessionStartPayload } from '@termrelay/contracts';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { SessionStartEntity, type SessionStartStatus } from './session-start.entity';

@Injectable()
export class SessionStartRepository {
  constructor(@Optional() @InjectDataSource() private readonly source?: DataSource) {}

  async find(id: string): Promise<SessionStartEntity | null> {
    return this.repository.findOneBy({ id });
  }

  async reserve(id: string, deviceId: string, request: SessionStartPayload): Promise<boolean> {
    try {
      await this.repository.insert({ id, deviceId, request, status: 'pending', message: null });
      return true;
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw error;
    }
  }

  async update(id: string, status: SessionStartStatus, message: string | null): Promise<void> {
    await this.repository.update({ id, status: In(['pending', 'accepted', 'unknown']) }, { status, message });
  }

  async markUnknown(deviceId?: string): Promise<void> {
    await this.repository.update({
      ...(deviceId ? { deviceId } : {}), status: In(['pending', 'accepted']),
    }, { status: 'unknown', message: '连接中断，创建结果未知；请核实会话列表，不要自动重试。' });
  }

  countPending(deviceId: string): Promise<number> {
    return this.repository.countBy({ deviceId, status: In(['pending', 'accepted']) });
  }

  private get repository() {
    if (!this.source) throw new ServiceUnavailableException('Remote session creation requires a database.');
    return this.source.getRepository(SessionStartEntity);
  }
}
