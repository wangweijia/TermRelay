import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

test('creates the application module with database disabled', async () => {
  const previous = process.env.DB_ENABLED;
  process.env.DB_ENABLED = 'false';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  assert.ok(app.get(AppModule));
  await app.close();

  if (previous === undefined) delete process.env.DB_ENABLED;
  else process.env.DB_ENABLED = previous;
});
