import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { databaseOptions } from '../database/database.config';
import { TurnCommandRepository } from './turn-command.repository';

test('MySQL retains turn identity and late acknowledgement across fresh connections', {
  skip: process.env.TERMRELAY_RUN_TURN_MYSQL_PROBE !== '1',
}, async () => {
  assert.equal(process.env.DB_HOST, '127.0.0.1', 'Probe requires the local development database');
  assert.equal(process.env.DB_NAME, 'termrelay_dev');
  let db = new DataSource(databaseOptions());
  await db.initialize();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  const commandId = randomUUID();
  try {
    await db.query("INSERT INTO devices (id, name, capabilities) VALUES (?, 'Turn confirmation probe', '{}')", [deviceId]);
    await db.query("INSERT INTO workspaces (id, device_id, display_name) VALUES (?, ?, 'Probe')", [workspaceId, deviceId]);
    await db.query("INSERT INTO sessions (id, device_id, workspace_id, tool_key, runtime_mode, status) VALUES (?, ?, ?, 'codex', 'acp', 'running')", [sessionId, deviceId, workspaceId]);
    const envelope = { type: 'tool.turn.start', protocolVersion: '2' as const, messageId: randomUUID(), commandId,
      deviceId, sessionId, sentAt: new Date().toISOString(), payload: { text: 'private prompt', attachments: [randomUUID()] } };
    const a = new TurnCommandRepository(db);
    const b = new TurnCommandRepository(db);
    const reservations = await Promise.all([a.reserve(envelope), b.reserve(envelope)]);
    assert.deepEqual(reservations.sort(), [false, true]);
    assert.equal((await a.find(commandId))?.ack, null);
    await db.destroy();
    db = new DataSource(databaseOptions());
    await db.initialize();
    const restored = new TurnCommandRepository(db);
    assert.equal((await restored.find(commandId))?.requestHash.length, 64);
    assert.equal(await restored.reserve({ ...envelope, payload: { text: 'changed payload' } }), false);
    await restored.acknowledge(commandId, { commandId, status: 'completed' });
    // A delayed accepted ACK must not overwrite a completed result.
    await restored.acknowledge(commandId, { commandId, status: 'accepted' });
    assert.equal((await new TurnCommandRepository(db).find(commandId))?.ack?.status, 'completed');
    const rows = await db.query('SELECT * FROM commands WHERE command_id = ?', [commandId]);
    assert.doesNotMatch(JSON.stringify(rows), /private prompt|changed payload/);
  } finally {
    if (db.isInitialized) {
      await db.query('DELETE FROM commands WHERE command_id = ?', [commandId]);
      await db.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
      await db.query('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
      await db.query('DELETE FROM devices WHERE id = ?', [deviceId]);
      await db.destroy();
    }
  }
});
