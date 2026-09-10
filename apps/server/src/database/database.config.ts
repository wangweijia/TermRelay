import type { MysqlConnectionOptions } from 'typeorm/driver/mysql/MysqlConnectionOptions';
import { InitialSchema1788966000000 } from './migrations/1788966000000-initial-schema';

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
    migrations: [InitialSchema1788966000000],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
