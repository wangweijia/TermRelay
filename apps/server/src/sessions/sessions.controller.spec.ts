import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { SessionRecord } from './session.repository';
import { SessionsController } from './sessions.controller';
import type { SessionsService } from './sessions.service';

test('returns session details and ordered events', async () => {
  const expected = record();
  const controller = new SessionsController({
    list: async () => [expected],
    findById: async () => expected,
    listEvents: async () => [
      {
        seq: 1,
        type: 'terminal.output',
        payload: { encoding: 'base64', data: 'dGVzdA==' },
        createdAt: expected.createdAt,
      },
    ],
  } as unknown as SessionsService);

  assert.deepEqual(await controller.list(), [expected]);
  assert.equal(await controller.findById('session-a'), expected);
  assert.equal((await controller.listEvents('session-a', '0', '10'))[0]?.seq, 1);
});

test('returns 404 for unknown sessions', async () => {
  const controller = new SessionsController({
    findById: async () => undefined,
    listEvents: async () => undefined,
  } as unknown as SessionsService);

  await assert.rejects(
    () => controller.findById('missing'),
    (error: unknown) => error instanceof NotFoundException,
  );
  await assert.rejects(
    () => controller.listEvents('missing'),
    (error: unknown) => error instanceof NotFoundException,
  );
});

test('rejects invalid event pagination', async () => {
  const controller = new SessionsController({} as SessionsService);
  await assert.rejects(
    () => controller.listEvents('session-a', 'invalid', '10'),
    (error: unknown) => error instanceof BadRequestException,
  );
  await assert.rejects(
    () => controller.listEvents('session-a', '0', '1001'),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test('deletes finished sessions with an explicit purge choice', async () => {
  const calls: Array<{ id: string; purge: boolean }> = [];
  const controller = new SessionsController({
    deleteFinished: async (id: string, purge: boolean) => {
      calls.push({ id, purge });
      return 'deleted';
    },
  } as unknown as SessionsService);

  assert.deepEqual(await controller.deleteFinished('session-a'), {
    deleted: true,
    purged: false,
  });
  assert.deepEqual(await controller.deleteFinished('session-b', 'true'), {
    deleted: true,
    purged: true,
  });
  assert.deepEqual(calls, [
    { id: 'session-a', purge: false },
    { id: 'session-b', purge: true },
  ]);
});

test('rejects deletion for active, missing, and invalid purge requests', async () => {
  const active = new SessionsController({
    deleteFinished: async () => 'not_finished',
  } as unknown as SessionsService);
  const missing = new SessionsController({
    deleteFinished: async () => 'not_found',
  } as unknown as SessionsService);

  await assert.rejects(
    () => active.deleteFinished('session-a', 'false'),
    (error: unknown) => error instanceof ConflictException,
  );
  await assert.rejects(
    () => missing.deleteFinished('session-a', 'true'),
    (error: unknown) => error instanceof NotFoundException,
  );
  await assert.rejects(
    () => active.deleteFinished('session-a', 'yes'),
    (error: unknown) => error instanceof BadRequestException,
  );
});

function record(): SessionRecord {
  const timestamp = new Date(1_000).toISOString();
  return {
    id: 'session-a',
    deviceId: 'device-a',
    workspaceId: 'workspace-a',
    toolKey: 'codex',
    displayName: 'API 调试',
    runtimeMode: 'terminal',
    status: 'running',
    stateVersion: 1,
    startedAt: timestamp,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
