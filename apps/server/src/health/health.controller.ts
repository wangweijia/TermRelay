import { Controller, Get, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  @Get()
  async check(): Promise<{
    status: 'ok';
    service: 'termrelay-server';
    database: 'connected' | 'disabled';
  }> {
    if (!this.dataSource) {
      return { status: 'ok', service: 'termrelay-server', database: 'disabled' };
    }

    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', service: 'termrelay-server', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
