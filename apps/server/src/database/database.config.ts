import type { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { DeviceEntity } from '../devices/device.entity';
import { SessionEventEntity } from '../sessions/session-event.entity';
import { SessionEntity } from '../sessions/session.entity';
import { WorkspaceEntity } from '../sessions/workspace.entity';
import { InitialSchema1788966000000 } from './migrations/1788966000000-initial-schema';
import { SessionRuntimeMode1789056300000 } from './migrations/1789056300000-session-runtime-mode';
import { SessionSoftDelete1789178400000 } from './migrations/1789178400000-session-soft-delete';
import { SessionDisplayName1789264800000 } from './migrations/1789264800000-session-display-name';

export function databaseOptions(): MysqlConnectionOptions {
  return {
    type: 'mysql',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT ?? '3306', 10),
    database: required('DB_NAME'),
    username: required('DB_USER'),
    password: required('DB_PASSWORD'),
    charset: 'utf8mb4',
    timezone: 'Z',
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'none',
    migrationsTableName: 'typeorm_migrations',
    migrations: [
      InitialSchema1788966000000,
      SessionRuntimeMode1789056300000,
      SessionSoftDelete1789178400000,
      SessionDisplayName1789264800000,
    ],
    entities: [DeviceEntity, WorkspaceEntity, SessionEntity, SessionEventEntity],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
