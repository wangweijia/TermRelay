import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { AIService } from './ai.service';
import { AIRepository } from './ai.repository';
import { AIController, isLAN } from './ai.controller';
import { extractResult, validateRequest } from './ai.validation';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { ProtocolValidator } from '../realtime/protocol-validator';
import { AISettingsService } from './ai-settings.service';
import { AISettingsController } from './ai-settings.controller';
import { DevicesService } from '../devices/devices.service';
import { DeviceRepository } from '../devices/device.repository';
import type { FastifyRequest } from 'fastify';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { AIResourceEntity } from './ai.entity';

class Store extends AIRepository {
  failNextCommit = false;
  override get persistent() { return true; }
  override transaction<T>(fn: (rows: Map<string,AIResourceEntity>) => T | Promise<T>): Promise<T> {
    return super.transaction(async rows => {
      const result = await fn(rows);
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('commit_failed'); }
      return result;
    });
  }
}
function fixture() {
  const repo = new Store();
  const registry = new DeviceConnectionRegistry();
  const messages: Array<{data:{type:string;payload:Record<string,unknown>}}> = [];
  const client = {readyState:1,send:(s:string)=>messages.push(JSON.parse(s)),close:()=>undefined} as unknown as WebSocket;
  const deviceId = randomUUID();
  registry.connect(client); registry.register(client,deviceId,{name:'Mac',appVersion:'1',platform:'macOS',tools:[]});
  const service = new AIService(repo,registry);
  service.publishCapabilities(client,deviceId,{providers:[{provider:'codex',capacity:4,workspaceEnabled:false}]});
  const token = `trai_${randomBytes(32).toString('base64url')}`;
  const key = {id:randomUUID(),projectId:'invest',keyHash:createHash('sha256').update(token).digest('hex'),grants:{unrestricted:true},revoked:false};
  repo.keys.set(key.id,key);
  const body = {target:{deviceId},provider:'codex' as const};
  const turnBody = {input:{instructions:'Analyze',facts:{snapshotId:'1'}},output:{kind:'json' as const,schema:{type:'object',required:['answer'],properties:{answer:{type:'string'}},additionalProperties:false}}};
  const devices = new DevicesService(registry,new DeviceRepository());
  return {repo,registry,client,messages,deviceId,service,token,key,body,turnBody,devices};
}
async function runningTurn(f: ReturnType<typeof fixture>, idem: string) {
  const conversation = await f.service.create(f.key,f.body,`${idem}-conversation`);
  await f.service.update(f.client,f.deviceId,{id:conversation.id,status:'ready'});
  return f.service.turn(f.key,conversation.id,f.turnBody,idem);
}

test('Web settings generate, rotate and revoke general keys without project or device configuration', async () => {
  const f = fixture();
  const settings = new AISettingsService(f.repo);
  const created = await settings.create({});
  assert.match(created.apiKey,/^trai_[a-zA-Z0-9_-]{43}$/);
  assert.equal('keyHash' in created,false);
  assert.equal((await f.service.authenticate(`Bearer ${created.apiKey}`)).grants.unrestricted,true);
  assert.equal('projectId' in created,false);
  assert.equal('grants' in created,false);
  const replacement = await settings.rotate(created.id);
  assert.notEqual(replacement.apiKey,created.apiKey);
  assert.equal(replacement.legacy,false);
  await f.service.authenticate(`Bearer ${created.apiKey}`);
  await settings.revoke(created.id);
  await settings.revoke(created.id);
  await assert.rejects(f.service.authenticate(`Bearer ${created.apiKey}`),{status:401});
  await f.service.authenticate(`Bearer ${replacement.apiKey}`);
  await assert.rejects(settings.rotate(created.id),{status:404});
  const summaries = await settings.list();
  assert.ok(summaries.every(key => !('apiKey' in key) && !('keyHash' in key)));
  for (const invalid of [{projectId:'invest'},{capacity:2},{deviceIds:[]},{providers:[]},{extra:true},null,[]])
    assert.throws(() => settings.create(invalid),{status:400});
});

test('Web key management accepts the existing Web proxy boundary and rejects cross-origin and API-key admin requests', async () => {
  const f = fixture();
  const controller = new AISettingsController(new AISettingsService(f.repo),f.repo,f.service,f.devices);
  const request = {ip:'192.168.1.3',headers:{host:'192.168.1.2:3007',origin:'http://192.168.1.2:3007','x-termrelay-settings':'1','sec-fetch-site':'same-origin'}} as unknown as FastifyRequest;
  const overview = await controller.overview(request);
  assert.ok(Array.isArray(overview.keys));
  const input = {};
  const created = await controller.create(request,input);
  assert.equal(created.legacy,false);
  const proxied = {...request,ip:'8.8.8.8',headers:{...request.headers,host:'termrelay.example.com',origin:'https://termrelay.example.com','cf-ray':'test-ray','cf-access-jwt-assertion':'forwarded-by-access','x-forwarded-for':'8.8.8.8'}} as unknown as FastifyRequest;
  assert.ok(Array.isArray((await controller.overview(proxied)).keys));
  const remoteKey = await controller.create(proxied,input);
  const rotatedKey = await controller.rotate(proxied,remoteKey.id);
  assert.notEqual(rotatedKey.apiKey,remoteKey.apiKey);
  await controller.revoke(proxied,remoteKey.id);
  for (const bad of [
    {...request,headers:{...request.headers,authorization:`Bearer ${f.token}`}},
    {...request,headers:{...request.headers,origin:'https://evil.example'}},
    {...request,headers:{...request.headers,'sec-fetch-site':'cross-site'}},
    {...request,headers:{host:request.headers.host}},
  ]) assert.throws(() => controller.create(bad as FastifyRequest,input),{status:403});
  await controller.revoke(request,created.id);
});

test('key generation works without any connected Mac or providers and concurrent requests create independent keys', async () => {
  const f = fixture(); const settings = new AISettingsService(f.repo);
  f.registry.disconnect(f.client);
  const results = await Promise.all([settings.create(),settings.create({})]);
  assert.notEqual(results[0]!.apiKey,results[1]!.apiKey);
  assert.equal((await settings.list()).filter(k => results.some(r => r.id === k.id)).length,2);
});

test('browser targets show live AI providers, online devices without capabilities and persisted offline devices without requiring a database or key', async () => {
  const f = fixture();
  const stored = (await f.devices.list())[0]!;
  const historicalId = randomUUID();
  class HistoricalDevices extends DevicesService {
    override async list() { return [...await super.list(),{...stored,id:historicalId,name:'Old Mac',status:'offline' as const}]; }
  }
  const noDatabase = new AIRepository();
  const controller = new AISettingsController(new AISettingsService(noDatabase),noDatabase,f.service,new HistoricalDevices(f.registry,new DeviceRepository()));
  const request = {headers:{host:'termrelay.example.com','cf-ray':'test-ray','x-forwarded-for':'8.8.8.8'}} as unknown as FastifyRequest;
  let targets = await controller.targets(request);
  assert.equal(targets.find(t => t.deviceId === f.deviceId)?.providers[0]?.provider,'codex');
  assert.equal(targets.find(t => t.deviceId === f.deviceId)?.online,true);
  assert.deepEqual(targets.find(t => t.deviceId === historicalId),{deviceId:historicalId,name:'Old Mac',online:false,providers:[]});
  f.service.publishCapabilities(f.client,f.deviceId,{providers:[]});
  targets = await controller.targets(request);
  assert.deepEqual(targets.find(t => t.deviceId === f.deviceId)?.providers,[]);
  assert.equal(targets.find(t => t.deviceId === f.deviceId)?.online,true);
  f.registry.disconnect(f.client);
  targets = await controller.targets(request);
  assert.equal(targets.find(t => t.deviceId === f.deviceId)?.online,false);
  assert.deepEqual(targets.find(t => t.deviceId === f.deviceId)?.providers,[]);
  await assert.rejects(controller.targets({...request,headers:{...request.headers,authorization:`Bearer ${f.token}`}} as FastifyRequest),{status:403});
});

test('settings HTTP routes allow Access/Tunnel headers, return one-time keys with no-store and reject cross-site writes', async () => {
  const f = fixture();
  @Module({controllers:[AISettingsController],providers:[
    {provide:AISettingsService,useValue:new AISettingsService(f.repo)},
    {provide:AIService,useValue:f.service},
    {provide:AIRepository,useValue:f.repo},
    {provide:DevicesService,useValue:f.devices},
  ]}) class SettingsTestModule {}
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(SettingsTestModule,adapter,{logger:false});
  try {
    await app.init();
    const http = adapter.getInstance();
    const headers = {host:'termrelay.example.com',origin:'https://termrelay.example.com','x-termrelay-settings':'1','cf-ray':'test-ray','cf-access-jwt-assertion':'forwarded-by-access','x-forwarded-for':'8.8.8.8'};
    const targets = await http.inject({method:'GET',url:'/api/settings/ai/targets',headers});
    assert.equal(targets.statusCode,200);
    assert.equal(targets.headers['cache-control'],'no-store');
    assert.equal(targets.json()[0].deviceId,f.deviceId);
    assert.equal(targets.json()[0].providers[0].provider,'codex');
    f.registry.disconnect(f.client);
    const created = await http.inject({method:'POST',url:'/api/settings/ai/keys',headers,payload:{}});
    assert.equal(created.statusCode,201);
    assert.equal(created.headers['cache-control'],'no-store');
    const data = created.json() as {id:string;apiKey:string};
    assert.match(data.apiKey,/^trai_/);
    const listed = await http.inject({method:'GET',url:'/api/settings/ai',headers});
    assert.equal(listed.statusCode,200);
    assert.equal(listed.headers['cache-control'],'no-store');
    assert.equal(listed.body.includes(data.apiKey),false);
    assert.equal(listed.body.includes('keyHash'),false);
    const forbidden = await http.inject({method:'POST',url:`/api/settings/ai/keys/${data.id}/revoke`,headers:{...headers,origin:'https://evil.example'},payload:{}});
    assert.equal(forbidden.statusCode,403);
    const revoked = await http.inject({method:'POST',url:`/api/settings/ai/keys/${data.id}/revoke`,headers,payload:{}});
    assert.equal(revoked.statusCode,200);
    await assert.rejects(f.service.authenticate(`Bearer ${data.apiKey}`),{status:401});
  } finally { await app.close(); }
});

test('general keys choose provider and model without business configuration while execution admission remains enforced', async () => {
  const f = fixture(); const settings = new AISettingsService(f.repo);
  const created = await settings.create();
  const key = await f.service.authenticate(`Bearer ${created.apiKey}`);
  assert.ok(f.service.targets(key).length > 0);
  const previous = await f.service.create(f.key,f.body,'previous-task-key');
  assert.equal((await f.service.get(key,previous.id)).id,previous.id);
  const conversation = await f.service.create(key,f.body,'general-task-key');
  const other = await settings.create();
  const otherKey = await f.service.authenticate(`Bearer ${other.apiKey}`);
  assert.equal((await f.service.get(otherKey,conversation.id)).id,conversation.id);
  assert.equal((await f.service.create(otherKey,f.body,'general-task-key')).id,conversation.id);
  await f.service.close(otherKey,conversation.id);
  await assert.rejects(f.service.create(key,{...f.body,provider:'dsh'},'missing-provider-key'),{status:409});
  const chosen = await f.service.create(key,{...f.body,model:'caller-model',effort:'high'},'caller-model-key');
  assert.equal(chosen.model,'caller-model');
  assert.equal(f.messages.at(-1)?.data.payload.model,'caller-model');
  assert.throws(() => validateRequest('conversation',{...f.body,profile:'removed'}),{status:400});
});

test('legacy keys cannot silently gain execution privileges and revoked credentials remain rejected', async () => {
  const f = fixture();
  await assert.rejects(f.service.authenticate(),{status:401});
  assert.equal((await f.service.authenticate(`Bearer ${f.token}`)).projectId,'invest');
  const r = await runningTurn(f,'request-key-1');
  const foreign = {...f.key,projectId:'other',grants:{...f.key.grants,unrestricted:false,deviceIds:[]}};
  assert.deepEqual(f.service.targets(foreign),[]);
  await assert.rejects(f.service.get(foreign,r.id),{status:404});
  await assert.rejects(f.service.cancel(foreign,r.id,r.sessionId),{status:404});
  await assert.rejects(f.service.create(foreign,f.body,'foreign-key'),{status:403});
  const legacy = {...f.key,grants:{unrestricted:false,deviceIds:[f.deviceId],capacity:4}};
  await assert.rejects(f.service.create(legacy,f.body,'legacy-key'),{status:403,message:'legacy_key_requires_replacement'});
  assert.equal((await f.service.get(legacy,r.id)).id,r.id);
  f.key.revoked = true;
  await assert.rejects(f.service.authenticate(`Bearer ${f.token}`),{status:401});
});
test('concurrent idempotency reserves one resource; conflicting input never runs', async () => {
  const f = fixture();
  const resources = await Promise.all(Array.from({length:8},()=>f.service.create(f.key,f.body,'repeat-key')));
  assert.equal(new Set(resources.map(r=>r.id)).size,1);
  assert.equal(await f.repo.transaction(rows=>rows.size),1);
  await assert.rejects(f.service.create(f.key,{...f.body,displayName:'changed'},'repeat-key'),{status:409});
  const rotated = {...f.key,id:randomUUID()};
  assert.equal((await f.service.create(rotated,f.body,'repeat-key')).id,resources[0]!.id);
});
test('JSON results are turn-correlated, terminal and acknowledged only after persistence', async () => {
  const f = fixture();
  const r = await runningTurn(f,'result-key');
  const messageCount = f.messages.length;
  await f.service.update(f.client,f.deviceId,{id:r.sessionId,turnId:r.id,status:'running'});
  assert.equal(f.messages.length,messageCount,'running updates must not acknowledge an unpersisted final result');
  assert.equal(await f.service.update(f.client,f.deviceId,{id:r.sessionId,turnId:randomUUID(),status:'succeeded',text:'{}'}),false);
  assert.equal(await f.service.update(f.client,f.deviceId,{id:r.sessionId,turnId:r.id,status:'succeeded',text:'```json\n{"answer":"ok"}\n```'}),true);
  assert.deepEqual((await f.service.get(f.key,r.id)).result,{answer:'ok'});
  assert.equal(await f.service.update(f.client,f.deviceId,{id:r.sessionId,turnId:r.id,status:'running'}),false);
  assert.equal((await f.service.get(f.key,r.id)).status,'succeeded');
  assert.equal(f.messages.at(-1)?.data.type,'ai.result.ack');
});
test('conversation runs successive turns and explicit close drains the active turn', async () => {
  const f = fixture();
  const c = await f.service.create(f.key,f.body,'conversation-key');
  await assert.rejects(f.service.turn(f.key,c.id,f.turnBody,'turn-key-1'),{status:409});
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
  const t = await f.service.turn(f.key,c.id,f.turnBody,'turn-key-1');
  await assert.rejects(f.service.turn(f.key,c.id,f.turnBody,'turn-key-2'),{status:409});
  await f.service.update(f.client,f.deviceId,{id:c.id,turnId:t.id,status:'succeeded',text:'{"answer":"first"}'});
  assert.equal((await f.service.get(f.key,c.id)).status,'ready');
  const t2 = await f.service.turn(f.key,c.id,{input:{facts:{snapshotId:'2'}},output:f.turnBody.output},'turn-key-2');
  assert.notEqual(t2.id,t.id); assert.equal(t2.sessionId,c.id);
  await f.service.close(f.key,c.id);
  assert.equal((await f.service.get(f.key,c.id)).status,'closing');
  assert.equal((await f.service.get(f.key,t2.id)).status,'accepted');
  await assert.rejects(f.service.turn(f.key,c.id,f.turnBody,'turn-key-3'),{status:409,message:'conversation_closing'});
  await f.service.update(f.client,f.deviceId,{id:c.id,turnId:t2.id,status:'succeeded',text:'{"answer":"second"}'});
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'closed'});
  assert.equal((await f.service.get(f.key,c.id)).status,'closed');
  assert.equal((await f.service.get(f.key,c.id)).error,null);
  assert.equal((await f.service.get(f.key,t2.id)).status,'succeeded');
});
test('cancel is a request; timeout and disconnect never silently retry or accept late completion', async () => {
  const f = fixture();
  const r = await runningTurn(f,'cancel-key');
  const cancelled = await f.service.cancel(f.key,r.id,r.sessionId);
  assert.equal(cancelled.status,'accepted'); assert.equal(cancelled.cancelRequested,true);
  await f.service.tick(Date.now()+20000);
  assert.equal((await f.service.get(f.key,r.id)).error?.code,'cancel_timeout');
  const other = await runningTurn(f,'offline-key');
  await f.service.disconnected(f.deviceId);
  assert.equal((await f.service.get(f.key,other.id)).error?.executionOutcome,'unknown');
  assert.equal(await f.service.update(f.client,f.deviceId,{id:other.sessionId,turnId:other.id,status:'succeeded',text:'{"answer":"late"}'}),false);
  await f.service.onModuleInit(); f.service.onModuleDestroy();
});
test('JSON failures are explicit, schemas are bounded and raw input expires before result', async () => {
  const f = fixture();
  const r = await runningTurn(f,'invalid-key');
  await f.service.update(f.client,f.deviceId,{id:r.sessionId,turnId:r.id,status:'succeeded',text:'not json'});
  assert.equal((await f.service.get(f.key,r.id)).error?.code,'invalid_json');
  await f.service.tick(Date.now()+2*86400000);
  assert.equal((await f.service.get(f.key,r.id)).input,undefined);
  assert.equal((await f.service.get(f.key,r.id)).rawText,undefined);
  assert.throws(()=>extractResult('{"other":1}',f.turnBody.output),/schema_mismatch/);
  assert.throws(()=>validateRequest('turn',{...f.turnBody,output:{kind:'json',schema:{$ref:'https://example.com/schema'}}}));
  assert.throws(()=>validateRequest('turn',{...f.turnBody,output:{kind:'json',schema:{pattern:'(a+)+$'}}}));
});
test('LAN controller blocks forwarded/public requests and hides raw request data', async () => {
  const f = fixture(); const controller = new AIController(f.service,f.repo);
  for (const ip of ['127.0.0.1','::1','::ffff:192.168.1.10','10.1.2.3','172.16.0.2','fd00::1']) assert.equal(isLAN(ip),true);
  for (const ip of ['8.8.8.8','172.15.1.1','2001:db8::1','not-ip']) assert.equal(isLAN(ip),false);
  const request = {ip:'192.168.1.3',headers:{}} as FastifyRequest;
  const response = await controller.conversation(request,f.body,'http-key',`Bearer ${f.token}`);
  assert.equal('input' in response,false); assert.equal('fingerprint' in response,false);
  await assert.rejects(controller.targets({...request,headers:{'x-forwarded-for':'192.168.1.3'}} as FastifyRequest,`Bearer ${f.token}`),{status:403});
  await assert.rejects(controller.targets({...request,ip:'8.8.8.8'} as FastifyRequest,`Bearer ${f.token}`),{status:403});
});
test('AI wire validation rejects invalid messages and duplicate capability providers', () => {
  const validator = new ProtocolValidator();
  const msg = {type:'ai.update',protocolVersion:'2',messageId:randomUUID(),deviceId:randomUUID(),sentAt:new Date().toISOString(),payload:{id:randomUUID(),status:'succeeded',text:'{}'}};
  assert.equal(validator.validate(msg).ok,true);
  assert.equal(validator.validate({...msg,seq:0}).ok,false);
  assert.equal(validator.validate({...msg,payload:{...msg.payload,status:'invented'}}).ok,false);
  const provider = {provider:'codex',capacity:1,workspaceEnabled:false};
  assert.equal(validator.validate({...msg,type:'ai.capabilities',payload:{providers:[provider,provider]}}).ok,false);
});

test('capacity is per provider and socket replacement terminates old resources', async () => {
  const f = fixture();
  await f.service.onModuleInit();
  try {
    f.service.publishCapabilities(f.client,f.deviceId,{providers:[
      {provider:'codex',capacity:1,workspaceEnabled:false},
      {provider:'dsh',capacity:1,workspaceEnabled:false},
    ]});
    const first = await f.service.create(f.key,f.body,'capacity-first');
    await assert.rejects(f.service.create(f.key,f.body,'capacity-second'),{status:409});
    const second = await f.service.create(f.key,{...f.body,provider:'dsh'},'capacity-other');
    const next = {readyState:1,send:()=>undefined,close:()=>undefined} as unknown as WebSocket;
    f.registry.connect(next);
    f.registry.register(next,f.deviceId,{name:'Mac',appVersion:'1',platform:'macOS',tools:[]});
    assert.equal((await f.service.get(f.key,first.id)).status,'closed');
    assert.equal((await f.service.get(f.key,second.id)).status,'closed');
  } finally { f.service.onModuleDestroy(); }
});

test('omitted timeout never expires a conversation or implicitly cancels a long-running turn', async () => {
  const f = fixture();
  const t = await runningTurn(f,'unbounded-turn');
  await f.service.tick(Date.now()+7*86400000);
  assert.equal((await f.service.get(f.key,t.sessionId)).status,'ready');
  assert.equal((await f.service.get(f.key,t.sessionId)).expiresAt,null);
  assert.equal((await f.service.get(f.key,t.id)).cancelRequested,false);
  assert.equal(f.messages.some(m => m.data.type === 'ai.turn.cancel' || m.data.type === 'ai.session.close'),false);
  assert.equal('deadlineAt' in f.messages.find(m => m.data.type === 'ai.turn.start')!.data.payload,false);
});

test('optional timeout rejects new turns and drains the active turn before closing', async () => {
  const f = fixture();
  const c = await f.service.create(f.key,{...f.body,timeoutSeconds:5},'expiry-conversation');
  assert.equal(Date.parse(c.expiresAt!)-Date.parse(c.createdAt),5000);
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
  const t = await f.service.turn(f.key,c.id,f.turnBody,'expiry-turn');
  await f.service.update(f.client,f.deviceId,{id:c.id,turnId:t.id,status:'running',waitingFor:'input'});
  await f.service.tick(Date.parse(c.expiresAt!));
  const draining = await f.service.get(f.key,c.id);
  assert.equal(draining.status,'closing');
  assert.equal(draining.closeReason,'timeout');
  assert.equal(draining.activeTurnId,t.id);
  assert.equal((await f.service.get(f.key,t.id)).waitingFor,'input');
  assert.equal(f.messages.some(m => m.data.type === 'ai.turn.cancel' || m.data.type === 'ai.session.close'),false);
  await assert.rejects(f.service.turn(f.key,c.id,f.turnBody,'after-expiry'),{status:409,message:'conversation_closing'});
  assert.equal((await f.service.turn(f.key,c.id,f.turnBody,'expiry-turn')).id,t.id,'idempotent retries still return the accepted turn');
  assert.equal(await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'}),false,'late ready cannot reopen a draining conversation');
  await f.service.update(f.client,f.deviceId,{id:c.id,turnId:t.id,status:'succeeded',text:'{"answer":"finished"}'});
  assert.equal((await f.service.get(f.key,t.id)).status,'succeeded');
  assert.equal(f.messages.filter(m => m.data.type === 'ai.session.close').length,1);
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'closed'});
  const closed = await f.service.get(f.key,c.id);
  assert.equal(closed.status,'closed');
  assert.equal(closed.error,null);
  assert.equal(closed.closeReason,'timeout');
});

test('expiry is enforced atomically on turn admission even before the timer runs', async () => {
  const f = fixture();
  const c = await f.service.create(f.key,f.body,'admission-expiry');
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
  await f.repo.transaction(rows => { rows.get(c.id)!.data.expiresAt = new Date(Date.now()-1).toISOString(); });
  await assert.rejects(f.service.turn(f.key,c.id,f.turnBody,'too-late-turn'),{status:409,message:'conversation_closing'});
  assert.equal((await f.service.get(f.key,c.id)).status,'closing','expiry transition commits despite the rejected request');
  assert.equal(f.messages.filter(m => m.data.type === 'ai.session.close').length,1);
  assert.equal(f.messages.some(m => m.data.type === 'ai.turn.start'),false);
});

test('idle and starting conversations close on expiry; close delivery is idempotent and bounded', async () => {
  for (const ready of [false,true]) {
    const f = fixture();
    const c = await f.service.create(f.key,{...f.body,timeoutSeconds:1},'idle-expiry');
    if (ready) await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
    await f.service.tick(Date.parse(c.expiresAt!));
    await f.service.close(f.key,c.id);
    await f.service.tick(Date.parse(c.expiresAt!)+5000);
    assert.equal(f.messages.filter(m => m.data.type === 'ai.session.close').length,1);
    assert.equal((await f.service.get(f.key,c.id)).status,'closing');
    await f.service.tick(Date.parse(c.expiresAt!)+10000);
    assert.equal((await f.service.get(f.key,c.id)).error?.code,'close_timeout');
  }
});

test('expired conversations preserve succeeded, failed and cancelled turn outcomes', async () => {
  for (const status of ['succeeded','failed','cancelled'] as const) {
    const f = fixture();
    const t = await runningTurn(f,`finish-${status}`);
    await f.repo.transaction(rows => { rows.get(t.sessionId)!.data.expiresAt = new Date(Date.now()-1).toISOString(); });
    await f.service.update(f.client,f.deviceId,{id:t.sessionId,turnId:t.id,status,text:'{"answer":"done"}',...(status === 'failed' ? {errorCode:'agent_failed'}:{})});
    assert.equal((await f.service.get(f.key,t.id)).status,status);
    assert.equal((await f.service.get(f.key,t.sessionId)).status,'closing');
    await f.service.update(f.client,f.deviceId,{id:t.sessionId,status:'closed'});
    assert.equal((await f.service.get(f.key,t.id)).status,status);
    assert.equal((await f.service.get(f.key,t.sessionId)).error,null);
  }
});

test('capacity remains occupied until Mac confirms the runtime has closed', async () => {
  const f = fixture();
  f.service.publishCapabilities(f.client,f.deviceId,{providers:[{provider:'codex',capacity:1,workspaceEnabled:false}]});
  const c = await f.service.create(f.key,f.body,'capacity-close');
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
  await f.service.close(f.key,c.id);
  await assert.rejects(f.service.create(f.key,f.body,'capacity-replacement'),{status:409,message:'device_busy'});
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'closed'});
  assert.equal((await f.service.create(f.key,f.body,'capacity-replacement')).status,'starting');
});

test('conversation timeout input is bounded and the removed modes and turn deadlines are rejected', () => {
  const f = fixture();
  for (const timeoutSeconds of [0,-1,1.5,null,'30',2147483648])
    assert.throws(() => validateRequest('conversation',{...f.body,timeoutSeconds}),{status:400});
  for (const timeoutSeconds of [1,180,86400,2147483647])
    assert.doesNotThrow(() => validateRequest('conversation',{...f.body,timeoutSeconds}));
  assert.throws(() => validateRequest('conversation',{...f.body,lifecycle:'oneShot'}),{status:400});
  assert.throws(() => validateRequest('conversation',{...f.body,input:f.turnBody.input,output:f.turnBody.output}),{status:400});
  assert.throws(() => validateRequest('turn',{...f.turnBody,deadlineSeconds:180}),{status:400});
});

test('failed persistence cannot dispatch cancellation or closure commands', async () => {
  const f = fixture();
  const c = await f.service.create(f.key,f.body,'failed-close-commit');
  await f.service.update(f.client,f.deviceId,{id:c.id,status:'ready'});
  const before = f.messages.length;
  f.repo.failNextCommit = true;
  await assert.rejects(f.service.close(f.key,c.id),/commit_failed/);
  assert.equal(f.messages.length,before);
  assert.equal((await f.service.get(f.key,c.id)).status,'ready');
  const t = await f.service.turn(f.key,c.id,f.turnBody,'failed-cancel-commit');
  const beforeCancel = f.messages.length;
  f.repo.failNextCommit = true;
  await assert.rejects(f.service.cancel(f.key,t.id,c.id),/commit_failed/);
  assert.equal(f.messages.length,beforeCancel);
  assert.equal((await f.service.get(f.key,t.id)).cancelRequested,false);
  f.repo.failNextCommit = true;
  await assert.rejects(f.service.update(f.client,f.deviceId,{id:c.id,turnId:t.id,status:'succeeded',text:'{"answer":"done"}'}),/commit_failed/);
  assert.equal(f.messages.length,beforeCancel,'a result is not acknowledged before it commits');
  assert.equal((await f.service.get(f.key,t.id)).status,'accepted');
});

test('HTTP exposes only conversations and turns, hides internal timers and preserves result lookup', async () => {
  const f = fixture();
  @Module({controllers:[AIController],providers:[
    {provide:AIService,useValue:f.service},
    {provide:AIRepository,useValue:f.repo},
  ]}) class AITestModule {}
  const adapter = new FastifyAdapter();
  const app = await NestFactory.create(AITestModule,adapter,{logger:false});
  try {
    await app.init();
    const http = adapter.getInstance();
    const headers = {authorization:`Bearer ${f.token}`,'idempotency-key':'http-conversation'};
    const created = await http.inject({method:'POST',url:'/api/ai/v1/conversations',headers,payload:{...f.body,timeoutSeconds:60}});
    assert.equal(created.statusCode,202);
    const conversation = created.json() as {conversationId:string;status:string;expiresAt:string;links:{self:string}};
    assert.equal(conversation.status,'starting');
    assert.equal(conversation.links.self,`/api/ai/v1/conversations/${conversation.conversationId}`);
    assert.ok(conversation.expiresAt);
    for (const field of ['lifecycle','startupDeadlineAt','closeDeadlineAt','deadlineAt','input','fingerprint'])
      assert.equal(field in conversation,false);
    const repeated = await http.inject({method:'POST',url:'/api/ai/v1/conversations',headers,payload:{...f.body,timeoutSeconds:60}});
    assert.equal(repeated.json().expiresAt,conversation.expiresAt);
    await f.service.update(f.client,f.deviceId,{id:conversation.conversationId,status:'ready'});
    const turn = await http.inject({method:'POST',url:`${conversation.links.self}/turns`,headers:{...headers,'idempotency-key':'http-turn'},payload:f.turnBody});
    assert.equal(turn.statusCode,202);
    const {turnId,links} = turn.json() as {turnId:string;links:{self:string}};
    await f.service.update(f.client,f.deviceId,{id:conversation.conversationId,turnId,status:'succeeded',text:'{"answer":"http"}'});
    const result = await http.inject({method:'GET',url:links.self,headers});
    assert.equal(result.statusCode,200);
    assert.deepEqual(result.json().result,{answer:'http'});
    const closed = await http.inject({method:'DELETE',url:conversation.links.self,headers});
    assert.equal(closed.statusCode,202);
    assert.equal(closed.json().status,'closing');
    for (const [method,url] of [['POST','/jobs'],['GET','/jobs/legacy'],['POST','/jobs/legacy/cancel']] as const) {
      const retired = await http.inject({method,url:`/api/ai/v1${url}`,headers});
      assert.equal(retired.statusCode,404);
    }
  } finally { await app.close(); }
});
