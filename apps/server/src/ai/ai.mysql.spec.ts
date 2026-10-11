import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type WebSocket from 'ws';
import { databaseOptions } from '../database/database.config';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { AIRepository } from './ai.repository';
import { AIService } from './ai.service';
import { AISettingsService } from './ai-settings.service';
import { AIProjectKeyEntity, AIResourceEntity } from './ai.entity';

test('MySQL serializes idempotency and preserves results across service instances', {
  skip: process.env.TERMRELAY_RUN_AI_MYSQL_PROBE !== '1',
}, async () => {
  assert.equal(process.env.DB_HOST,'127.0.0.1','Probe is restricted to local development');
  assert.equal(process.env.DB_NAME,'termrelay_dev');
  const db = new DataSource(databaseOptions());
  await db.initialize();
  const projectId = `probe_${randomUUID()}`;
  const resourceIDs = new Set<string>();
  const keyID = randomUUID();
  const keyIDs = new Set<string>([keyID]);
  try {
    const registry = new DeviceConnectionRegistry();
    const client = {readyState:1,send:()=>undefined,close:()=>undefined} as unknown as WebSocket;
    const deviceId = randomUUID();
    registry.connect(client);
    registry.register(client,deviceId,{name:'AI DB probe',appVersion:'test',platform:'macOS',tools:[]});
    const token = `trai_${randomBytes(32).toString('base64url')}`;
    const keys = db.getRepository(AIProjectKeyEntity);
    await keys.insert({id:keyID,projectId,keyHash:createHash('sha256').update(token).digest('hex'),revoked:false,grants:{deviceIds:[deviceId],profiles:['probe'],capacity:2}});
    const a = new AIService(new AIRepository(db),registry);
    const b = new AIService(new AIRepository(db),registry);
    for (const service of [a,b]) service.publishCapabilities(client,deviceId,{profiles:[{id:'probe',version:1,provider:'codex',policy:'factsOnly',capacity:2}]});
    const key = await a.authenticate(`Bearer ${token}`);
    const body = {target:{deviceId},profile:'probe',provider:'codex' as const,input:{facts:{snapshot:1}},output:{kind:'json' as const,schema:{type:'object'}}};
    const [first,second] = await Promise.all([a.create(key,'job',body,'probe-idempotency'),b.create(key,'job',body,'probe-idempotency')]);
    resourceIDs.add(first.id); resourceIDs.add(second.id);
    assert.equal(first.id,second.id);
    assert.equal(first.status,'accepted');
    await a.update(client,deviceId,{id:first.id,turnId:first.id,status:'succeeded',text:'{"answer":"persisted"}'});
    const restored = await b.get(key,first.id);
    assert.equal(restored.status,'succeeded');
    assert.deepEqual(restored.result,{answer:'persisted'});
    assert.equal(restored.schemaHash?.length,64);
    await keys.update(keyID,{revoked:true});
    await assert.rejects(b.authenticate(`Bearer ${token}`),{status:401});
    const settings = new AISettingsService(new AIRepository(db));
    const created = await settings.create();
    keyIDs.add(created.id);
    const replacement = await settings.rotate(created.id);
    keyIDs.add(replacement.id);
    assert.equal(replacement.legacy,false);
    await settings.revoke(created.id);
    await assert.rejects(a.authenticate(`Bearer ${created.apiKey}`),{status:401});
    const generalKey = await a.authenticate(`Bearer ${replacement.apiKey}`);
    assert.equal(generalKey.grants.unrestricted,true);
    assert.equal((await a.get(generalKey,first.id)).status,'succeeded');
    assert.ok((await settings.list()).every(key => !('keyHash' in key) && !('apiKey' in key)));
  } finally {
    // Remove only records created by this probe, not development/user resources.
    for (const id of resourceIDs) await db.getRepository(AIResourceEntity).delete(id);
    for (const id of keyIDs) await db.getRepository(AIProjectKeyEntity).delete(id);
    await db.destroy();
  }
});
