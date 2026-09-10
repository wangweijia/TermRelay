import { DynamicModule, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseOptions } from './database.config';

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(): DynamicModule {
    if (process.env.DB_ENABLED !== 'true') {
      return { module: DatabaseModule };
    }

    return {
      module: DatabaseModule,
      imports: [TypeOrmModule.forRoot(databaseOptions())],
      exports: [TypeOrmModule],
    };
  }
}
