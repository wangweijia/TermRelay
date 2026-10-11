import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException, ConflictException, ServiceUnavailableException, BadRequestException, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AiCapabilities, AiProfile, AiUpdate, AiCreate, AiTurn, AiJobRequest, AiConversationRequest, AiTurnRequest } from '@termrelay/contracts';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { AIRepository } from './ai.repository';
import { AIProjectKeyEntity, AIResourceEntity, type AIResource } from './ai.entity';
import { extractResult, fingerprint, validateRequest } from './ai.validation';

export const isTerminal = (r: AIResource): boolean => ['closed','succeeded','failed','cancelled'].includes(r.status);

@Injectable()
export class AIService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AIService.name);
  private capabilities = new Map<string, { client: WebSocket; profiles: AiProfile[] }>();
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private lastPruneAt = 0;
  constructor(private readonly repo: AIRepository, private readonly registry: DeviceConnectionRegistry) {}

  async onModuleInit(): Promise<void> {
    await this.repo.transaction(rows => { for (const {data:r} of rows.values()) if (!isTerminal(r)) this.finish(r, 'server_restarted'); });
    this.unsubscribe = this.registry.subscribe(snapshot => {
      const previous = this.capabilities.get(snapshot.deviceId);
      if (snapshot.presence === 'offline' || (previous && this.registry.getClient(snapshot.deviceId) !== previous.client)) {
        this.capabilities.delete(snapshot.deviceId);
        void this.disconnected(snapshot.deviceId).catch(e => this.logger.error(String(e)));
      }
    });
    this.timer = setInterval(() => { void this.tick().catch(e => this.logger.error(String(e))); }, 1000);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.unsubscribe?.(); }

  async authenticate(header?: string): Promise<AIProjectKeyEntity> {
    const match = /^Bearer (trai_[a-zA-Z0-9_-]{43})$/.exec(header ?? '');
    if (!match) throw new UnauthorizedException('invalid_api_key');
    const key = await this.repo.key(createHash('sha256').update(match[1]!).digest('hex'));
    if (!key) throw new UnauthorizedException('invalid_api_key');
    return key;
  }

  publishCapabilities(client: WebSocket, deviceId: string, value: AiCapabilities): void {
    if (!this.registry.isRegisteredClient(client,deviceId)) return;
    this.capabilities.set(deviceId, {client,profiles:value.profiles});
  }
  targets(key: AIProjectKeyEntity): unknown[] {
    return this.registry.listDevices().filter(d => key.grants.unrestricted === true || key.grants.deviceIds.includes(d.deviceId)).map(d => ({
      deviceId:d.deviceId, name:d.name, online:!!this.registry.getClient(d.deviceId),
      profiles:this.profiles(d.deviceId).filter(p => key.grants.unrestricted === true || key.grants.profiles.includes(p.id)),
    }));
  }
  private profiles(deviceId: string): AiProfile[] {
    const c = this.capabilities.get(deviceId);
    return c && this.registry.getClient(deviceId) === c.client ? c.profiles : [];
  }

  async create(key: AIProjectKeyEntity, kind: 'job' | 'conversation', body: AiJobRequest | AiConversationRequest, idem: string): Promise<AIResource> {
    validateRequest(kind, body);
    return this.repo.transaction(rows => {
      const scope = this.scope(key,kind,idem);
      const old = [...rows.values()].find(r => r.idempotencyScope === scope);
      if (old) return this.repeat(old.data,body);
      const deviceId = body.target.deviceId.toLowerCase();
      const p = this.admit(key,deviceId,body.profile,body.provider);
      const active = [...rows.values()].map(r => r.data).filter(r => r.kind !== 'turn' && !isTerminal(r));
      if ((key.grants.unrestricted !== true && active.filter(r => r.projectId === key.projectId).length >= key.grants.capacity)
        || active.filter(r => r.deviceId === deviceId).length >= 4
        || active.filter(r => r.deviceId === deviceId && r.profile === p.id).length >= p.capacity) throw new ConflictException('device_busy');
      if (body.model && !p.models?.includes(body.model)) throw new BadRequestException('unsupported_model');
      if (body.effort && !p.efforts?.includes(body.effort)) throw new BadRequestException('unsupported_effort');
      const id = randomUUID();
      const now = new Date().toISOString();
      const job = body as AiJobRequest;
      const r: AIResource = { id,kind,projectId:key.projectId,deviceId,sessionId:id,profile:p.id,profileVersion:p.version,provider:body.provider,
        displayName:body.displayName ?? `${key.projectId} · ${body.profile}`,fingerprint:fingerprint(body),status:kind === 'job' ? 'accepted':'starting',
        activeTurnId:kind === 'job' ? id:null,waitingFor:null,cancelRequested:false,result:null,error:null,actualModel:null,actualEffort:null,usage:null,
        createdAt:now,finishedAt:null,deadlineAt:new Date(Date.now()+(kind === 'job' ? job.deadlineSeconds ?? 180:30)*1000).toISOString(),
        ...(body.model ? {model:body.model}:{}),...(body.effort ? {effort:body.effort}:{}),
        ...(kind === 'job' ? {input:job.input,output:job.output,...(job.output.schema ? {schemaHash:fingerprint(job.output.schema)}:{}),...(job.contextId ? {contextId:job.contextId}:{})}:{}),
      };
      rows.set(id,{id,idempotencyScope:scope,data:r});
      return r;
    }).then(async r => { await this.dispatchCreate(r); return r; });
  }
  private async dispatchCreate(r: AIResource): Promise<void> {
    if (isTerminal(r) || r.status === 'ready' || r.status === 'running') return;
    const payload: AiCreate = {id:r.id,projectId:r.projectId,profile:r.profile,profileVersion:r.profileVersion,provider:r.provider,
      lifecycle:r.kind === 'job' ? 'oneShot':'longLived',displayName:r.displayName,
      ...(r.model ? {model:r.model}:{}),...(r.effort ? {effort:r.effort}:{}),...(r.kind === 'job' ? {turn:this.turnPayload(r)}:{})};
    if (!this.send(r.deviceId,'ai.session.create',payload)) await this.disconnected(r.deviceId);
  }
  async turn(key: AIProjectKeyEntity, sessionId: string, body: AiTurnRequest, idem: string): Promise<AIResource> {
    validateRequest('turn',body);
    const r = await this.repo.transaction(rows => {
      const scope = this.scope(key,`turn:${sessionId}`,idem);
      const old = [...rows.values()].find(r => r.idempotencyScope === scope);
      if (old) return this.repeat(old.data,body);
      const c = this.owned(rows,key,sessionId,'conversation');
      this.admit(key,c.deviceId,c.profile,c.provider);
      if (c.status === 'closed') throw new ConflictException('conversation_closed');
      if (c.status !== 'ready') throw new ConflictException('conversation_not_ready');
      if (c.activeTurnId) throw new ConflictException('conversation_busy');
      const id = randomUUID();
      const r: AIResource = {...c,id,kind:'turn',sessionId:c.id,fingerprint:fingerprint(body),status:'accepted',activeTurnId:id,
        input:body.input,output:body.output,schemaHash:body.output.schema ? fingerprint(body.output.schema):undefined,result:null,error:null,cancelRequested:false,waitingFor:null,finishedAt:null,
        createdAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+(body.deadlineSeconds ?? 180)*1000).toISOString()};
      c.activeTurnId = id;
      rows.set(id,{id,idempotencyScope:scope,data:r});
      return r;
    });
    if (r.status === 'accepted' && !this.send(r.deviceId,'ai.turn.start',this.turnPayload(r))) await this.disconnected(r.deviceId);
    return r;
  }
  async get(key: AIProjectKeyEntity, id: string, kind?: AIResource['kind'], parent?: string): Promise<AIResource> {
    return this.repo.transaction(rows => {
      const r = this.owned(rows,key,id,kind);
      if (parent && r.sessionId !== parent) throw new NotFoundException();
      return {...r};
    });
  }
  async cancel(key: AIProjectKeyEntity, id: string, kind: 'job' | 'turn', parent?: string): Promise<AIResource> {
    return this.repo.transaction(rows => {
      const r = this.owned(rows,key,id,kind);
      if (parent && r.sessionId !== parent) throw new NotFoundException();
      if (!isTerminal(r)) this.requestCancel(r);
      return {...r};
    });
  }
  async close(key: AIProjectKeyEntity, id: string): Promise<AIResource> {
    return this.repo.transaction(rows => {
      const c = this.owned(rows,key,id,'conversation');
      if (c.status !== 'closed') {
        this.finish(c,'explicit_close');
        if (c.activeTurnId) { const turn = rows.get(c.activeTurnId)?.data; if (turn && !isTerminal(turn)) this.finish(turn,'explicit_close'); }
        this.send(c.deviceId,'ai.session.close',{id:c.id});
      }
      return {...c};
    });
  }
  async update(client: WebSocket, deviceId: string, u: AiUpdate): Promise<boolean> {
    if (!this.registry.isRegisteredClient(client,deviceId)) return false;
    const accepted = await this.repo.transaction(rows => {
      const session = rows.get(u.id)?.data;
      if (!session || session.deviceId !== deviceId || session.kind === 'turn' || isTerminal(session)) return false;
      if (u.status === 'ready' && session.kind === 'conversation') { session.status = 'ready'; session.actualModel = u.model ?? null; session.actualEffort = u.effort ?? null; return true; }
      if (u.status === 'closed') {
        if (session.activeTurnId) { const t = rows.get(session.activeTurnId)?.data; if (t && !isTerminal(t)) this.finish(t,u.errorCode ?? 'runtime_exited'); }
        this.finish(session,u.errorCode ?? 'runtime_exited'); return true;
      }
      if (u.status === 'failed' && session.kind === 'conversation' && !u.turnId && session.status === 'starting') {
        this.finish(session,u.errorCode ?? 'startup_failed','not_started'); return true;
      }
      const r = session.kind === 'job' ? session : rows.get(u.turnId ?? '')?.data;
      if (!r || r.sessionId !== session.id || r.id !== (session.activeTurnId ?? session.id) || isTerminal(r)) return false;
      if ((u.turnId && u.turnId !== r.id) || (['running','succeeded','cancelled'].includes(u.status) && u.turnId !== r.id)) return false;
      r.actualModel = u.model ?? r.actualModel; r.actualEffort = u.effort ?? r.actualEffort;
      r.waitingFor = u.waitingFor === 'none' ? null : u.waitingFor ?? r.waitingFor;
      if (u.status === 'running') { r.status = 'running'; return true; }
      if (u.status === 'succeeded') {
        try { r.result = extractResult(u.text ?? '',r.output!); r.status = 'succeeded'; }
        catch (e) { this.finish(r,e instanceof Error ? e.message:'invalid_json','confirmed'); r.rawText = (u.text ?? '').slice(0,32768); }
      } else if (u.status === 'cancelled') r.status = 'cancelled';
      else this.finish(r,u.errorCode ?? 'agent_failed','confirmed');
      r.finishedAt = new Date().toISOString(); r.waitingFor = null; r.activeTurnId = null;
      if (session.kind === 'conversation') session.activeTurnId = null;
      return true;
    });
    if (['succeeded','failed','cancelled','closed'].includes(u.status))
      this.send(deviceId,'ai.result.ack',{id:u.id,...(u.turnId ? {turnId:u.turnId}:{})});
    return accepted;
  }
  async disconnected(deviceId: string): Promise<void> {
    await this.repo.transaction(rows => { for (const {data:r} of rows.values()) if (r.deviceId === deviceId && !isTerminal(r)) this.finish(r,'connection_lost'); });
  }
  async tick(now = Date.now()): Promise<void> {
    if (now - this.lastPruneAt > 3600000) { await this.repo.pruneSessionData(); this.lastPruneAt = now; }
    await this.repo.transaction(rows => {
      for (const [id,{data:r}] of rows) {
        if (isTerminal(r)) {
          const age = now - Date.parse(r.finishedAt!);
          if (age > 86400000) { delete r.input; delete r.rawText; if (r.output) r.output = {kind:r.output.kind}; }
          if (age > 30*86400000) rows.delete(id);
          continue;
        }
        if (r.kind === 'conversation') {
          if (r.status === 'starting' && now >= Date.parse(r.deadlineAt)) { this.finish(r,'startup_timeout','not_started'); this.send(r.deviceId,'ai.session.close',{id:r.id}); }
        } else if (r.cancelRequested && now >= Date.parse(r.cancelDeadlineAt!)) {
          this.finish(r,'cancel_timeout'); this.send(r.deviceId,'ai.session.close',{id:r.sessionId});
          const c = rows.get(r.sessionId)?.data; if (c && c.kind === 'conversation') this.finish(c,'cancel_timeout');
        } else if (!r.cancelRequested && now >= Date.parse(r.deadlineAt)) this.requestCancel(r);
      }
    });
  }
  private requestCancel(r: AIResource): void {
    r.cancelRequested = true;
    r.cancelDeadlineAt ??= new Date(Date.now()+10000).toISOString();
    if (!this.send(r.deviceId,'ai.turn.cancel',{id:r.sessionId,turnId:r.id})) this.finish(r,'connection_lost');
  }
  private admit(key: AIProjectKeyEntity, deviceId: string, profile: string, provider: string): AiProfile {
    if (key.grants.unrestricted !== true && (!key.grants.deviceIds.includes(deviceId) || !key.grants.profiles.includes(profile))) throw new ForbiddenException('profile_forbidden');
    if (!this.registry.getClient(deviceId)) throw new ServiceUnavailableException('device_offline');
    const p = this.profiles(deviceId).find(p => p.id === profile && p.provider === provider);
    if (!p) throw new ConflictException('capability_unavailable');
    return p;
  }
  private owned(rows: Map<string,AIResourceEntity>, key: AIProjectKeyEntity, id: string, kind?: AIResource['kind']): AIResource {
    const r = rows.get(id)?.data;
    if (!r || (key.grants.unrestricted !== true && r.projectId !== key.projectId) || (kind && r.kind !== kind)) throw new NotFoundException();
    return r;
  }
  private scope(key: AIProjectKeyEntity, operation: string, idem: string): string {
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(idem)) throw new BadRequestException('invalid_idempotency_key');
    return `${key.projectId}:${operation}:${idem}`;
  }
  private repeat(r: AIResource, body: unknown): AIResource { if (r.fingerprint !== fingerprint(body)) throw new ConflictException('idempotency_conflict'); return r; }
  private turnPayload(r: AIResource): AiTurn { return {id:r.id,sessionId:r.sessionId,input:r.input!,output:r.output!,deadlineAt:r.deadlineAt}; }
  private finish(r: AIResource, code: string, outcome: 'unknown' | 'confirmed' | 'not_started' = 'unknown'): void {
    r.status = r.kind === 'conversation' ? 'closed':'failed'; r.finishedAt = new Date().toISOString();
    r.waitingFor = null; r.error = {code,message:code,executionOutcome:outcome};
  }
  private send(deviceId: string, type: string, payload: unknown): boolean {
    try { const client = this.registry.getClient(deviceId); if (!client || client.readyState !== 1) return false;
      client.send(JSON.stringify({event:'message',data:{type,protocolVersion:'2',messageId:randomUUID(),deviceId,sentAt:new Date().toISOString(),payload}})); return true;
    } catch { return false; }
  }
}
