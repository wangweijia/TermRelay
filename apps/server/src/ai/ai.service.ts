import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException, ConflictException, ServiceUnavailableException, BadRequestException, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AiCapabilities, AiProviderCapability, AiUpdate, AiCreate, AiTurn, AiConversationRequest, AiTurnRequest } from '@termrelay/contracts';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { AIRepository } from './ai.repository';
import { AIProjectKeyEntity, AIResourceEntity, type AIResource } from './ai.entity';
import { extractResult, fingerprint, validateRequest } from './ai.validation';

export const isTerminal = (r: AIResource): boolean => ['closed','succeeded','failed','cancelled'].includes(r.status);
interface AICommand { deviceId: string; type: string; payload: unknown }

@Injectable()
export class AIService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AIService.name);
  private capabilities = new Map<string, { client: WebSocket; providers: AiProviderCapability[] }>();
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
    this.capabilities.set(deviceId, {client,providers:value.providers});
  }
  availableTargets() {
    return this.registry.listDevices().map(d => ({
      deviceId:d.deviceId, name:d.name, online:!!this.registry.getClient(d.deviceId),
      providers:this.providers(d.deviceId),
    }));
  }
  targets(key: AIProjectKeyEntity) {
    return key.grants.unrestricted === true ? this.availableTargets() : [];
  }
  private providers(deviceId: string): AiProviderCapability[] {
    const c = this.capabilities.get(deviceId);
    return c && this.registry.getClient(deviceId) === c.client ? c.providers : [];
  }

  async create(key: AIProjectKeyEntity, body: AiConversationRequest, idem: string): Promise<AIResource> {
    validateRequest('conversation', body);
    return this.repo.transaction(rows => {
      const scope = this.scope(key,'conversation',idem);
      const old = [...rows.values()].find(r => r.idempotencyScope === scope);
      if (old) return this.repeat(old.data,body);
      const deviceId = body.target.deviceId.toLowerCase();
      const p = this.admit(key,deviceId,body.provider);
      const active = [...rows.values()].map(r => r.data).filter(r => r.kind === 'conversation' && !isTerminal(r));
      if (active.filter(r => r.deviceId === deviceId).length >= 4
        || active.filter(r => r.deviceId === deviceId && r.provider === p.provider).length >= p.capacity) throw new ConflictException('device_busy');
      const id = randomUUID();
      const now = new Date().toISOString();
      const r: AIResource = { id,kind:'conversation',projectId:key.projectId,deviceId,sessionId:id,provider:body.provider,
        displayName:body.displayName ?? body.provider,fingerprint:fingerprint(body),status:'starting',
        activeTurnId:null,waitingFor:null,cancelRequested:false,result:null,error:null,actualModel:null,actualEffort:null,usage:null,
        createdAt:now,finishedAt:null,startupDeadlineAt:new Date(Date.parse(now)+30000).toISOString(),
        expiresAt:body.timeoutSeconds === undefined ? null : new Date(Date.parse(now)+body.timeoutSeconds*1000).toISOString(),
        ...(body.model ? {model:body.model}:{}),...(body.effort ? {effort:body.effort}:{}),
      };
      rows.set(id,{id,idempotencyScope:scope,data:r});
      return r;
    }).then(async r => { await this.dispatchCreate(r); return r; });
  }
  private async dispatchCreate(r: AIResource): Promise<void> {
    if (r.status !== 'starting') return;
    const payload: AiCreate = {id:r.id,projectId:r.projectId,provider:r.provider,
      displayName:r.displayName,...(r.model ? {model:r.model}:{}),...(r.effort ? {effort:r.effort}:{})};
    if (!this.send(r.deviceId,'ai.session.create',payload)) await this.disconnected(r.deviceId);
  }
  async turn(key: AIProjectKeyEntity, sessionId: string, body: AiTurnRequest, idem: string): Promise<AIResource> {
    validateRequest('turn',body);
    const outcome = await this.mutate<{resource:AIResource} | {error:string}>((rows,commands) => {
      const scope = this.scope(key,`turn:${sessionId}`,idem);
      const old = [...rows.values()].find(r => r.idempotencyScope === scope);
      if (old) return {resource:this.repeat(old.data,body)};
      const c = this.owned(rows,key,sessionId,'conversation');
      if (c.status === 'closed') throw new ConflictException('conversation_closed');
      if (c.expiresAt && Date.now() >= Date.parse(c.expiresAt)) this.requestClose(c,'timeout',commands);
      if (c.status === 'closing') return {error:'conversation_closing'};
      if (c.status !== 'ready') throw new ConflictException('conversation_not_ready');
      if (c.activeTurnId) throw new ConflictException('conversation_busy');
      this.admit(key,c.deviceId,c.provider);
      const id = randomUUID();
      const r: AIResource = {id,kind:'turn',projectId:c.projectId,deviceId:c.deviceId,sessionId:c.id,provider:c.provider,
        displayName:c.displayName,...(c.model ? {model:c.model}:{}),...(c.effort ? {effort:c.effort}:{}),
        actualModel:c.actualModel,actualEffort:c.actualEffort,usage:null,
        fingerprint:fingerprint(body),status:'accepted',activeTurnId:id,
        input:body.input,output:body.output,schemaHash:body.output.schema ? fingerprint(body.output.schema):undefined,result:null,error:null,cancelRequested:false,waitingFor:null,finishedAt:null,
        createdAt:new Date().toISOString(),expiresAt:null};
      c.activeTurnId = id;
      rows.set(id,{id,idempotencyScope:scope,data:r});
      return {resource:r};
    });
    if ('error' in outcome) throw new ConflictException(outcome.error);
    const r = outcome.resource;
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
  async cancel(key: AIProjectKeyEntity, id: string, parent: string): Promise<AIResource> {
    return this.mutate((rows,commands) => {
      const r = this.owned(rows,key,id,'turn');
      if (parent && r.sessionId !== parent) throw new NotFoundException();
      if (!isTerminal(r)) this.requestCancel(r,commands);
      return {...r};
    });
  }
  async close(key: AIProjectKeyEntity, id: string): Promise<AIResource> {
    return this.mutate((rows,commands) => {
      const c = this.owned(rows,key,id,'conversation');
      if (c.status !== 'closed') this.requestClose(c,'explicit_close',commands);
      return {...c};
    });
  }
  async update(client: WebSocket, deviceId: string, u: AiUpdate): Promise<boolean> {
    if (!this.registry.isRegisteredClient(client,deviceId)) return false;
    const accepted = await this.mutate((rows,commands) => {
      const session = rows.get(u.id)?.data;
      if (!session || session.deviceId !== deviceId || session.kind === 'turn' || isTerminal(session)) return false;
      if (u.status === 'ready') {
        if (session.status !== 'starting' && session.status !== 'ready') return false;
        session.status = 'ready'; session.actualModel = u.model ?? null; session.actualEffort = u.effort ?? null;
        if (session.expiresAt && Date.now() >= Date.parse(session.expiresAt)) this.requestClose(session,'timeout',commands);
        return true;
      }
      if (u.status === 'closed') {
        if (session.activeTurnId) { const t = rows.get(session.activeTurnId)?.data; if (t && !isTerminal(t)) this.finish(t,u.errorCode ?? 'runtime_exited'); }
        if (session.status === 'closing' && !u.errorCode) {
          session.status = 'closed'; session.finishedAt = new Date().toISOString(); session.activeTurnId = null; session.waitingFor = null;
        } else this.finish(session,u.errorCode ?? 'runtime_exited');
        return true;
      }
      if (u.status === 'failed' && !u.turnId && session.status === 'starting') {
        this.finish(session,u.errorCode ?? 'startup_failed','not_started'); return true;
      }
      const r = rows.get(u.turnId ?? '')?.data;
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
      session.activeTurnId = null;
      if (session.status === 'closing' || (session.expiresAt && Date.now() >= Date.parse(session.expiresAt)))
        this.requestClose(session,session.closeReason ?? 'timeout',commands);
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
    await this.mutate((rows,commands) => {
      for (const [id,{data:r}] of rows) {
        if (isTerminal(r)) {
          const age = now - Date.parse(r.finishedAt!);
          if (age > 86400000) { delete r.input; delete r.rawText; if (r.output) r.output = {kind:r.output.kind}; }
          if (age > 30*86400000) rows.delete(id);
          continue;
        }
        if (r.kind === 'conversation') {
          if (r.status === 'closing') {
            if (r.closeDeadlineAt && now >= Date.parse(r.closeDeadlineAt)) this.finish(r,'close_timeout');
            else this.requestClose(r,r.closeReason ?? 'explicit_close',commands,now);
          } else if (r.expiresAt && now >= Date.parse(r.expiresAt)) {
            this.requestClose(r,'timeout',commands,now);
          } else if (r.status === 'starting' && now >= Date.parse(r.startupDeadlineAt!)) {
            this.finish(r,'startup_timeout','not_started');
            commands.push({deviceId:r.deviceId,type:'ai.session.close',payload:{id:r.id}});
          }
        } else if (r.cancelRequested && now >= Date.parse(r.cancelDeadlineAt!)) {
          this.finish(r,'cancel_timeout');
          const c = rows.get(r.sessionId)?.data;
          if (c && !isTerminal(c)) {
            c.activeTurnId = null; c.error = r.error;
            this.requestClose(c,'cancel_timeout',commands,now);
          }
        }
      }
    });
  }
  private requestCancel(r: AIResource, commands: AICommand[]): void {
    if (r.cancelRequested) return;
    r.cancelRequested = true;
    r.cancelDeadlineAt ??= new Date(Date.now()+10000).toISOString();
    commands.push({deviceId:r.deviceId,type:'ai.turn.cancel',payload:{id:r.sessionId,turnId:r.id}});
  }
  private requestClose(c: AIResource, reason: string, commands: AICommand[], now = Date.now()): void {
    c.status = 'closing'; c.closeReason ??= reason;
    if (c.activeTurnId || c.closeDeadlineAt) return;
    c.closeDeadlineAt = new Date(now+10000).toISOString();
    commands.push({deviceId:c.deviceId,type:'ai.session.close',payload:{id:c.id}});
  }
  private async mutate<T>(fn: (rows: Map<string,AIResourceEntity>, commands: AICommand[]) => T): Promise<T> {
    const commands: AICommand[] = [];
    const result = await this.repo.transaction(rows => fn(rows,commands));
    for (const command of commands) {
      if (!this.send(command.deviceId,command.type,command.payload)) await this.disconnected(command.deviceId);
    }
    return result;
  }
  private admit(key: AIProjectKeyEntity, deviceId: string, provider: string): AiProviderCapability {
    // Old profile-scoped credentials cannot silently gain broader execution access.
    if (key.grants.unrestricted !== true) throw new ForbiddenException('legacy_key_requires_replacement');
    if (!this.registry.getClient(deviceId)) throw new ServiceUnavailableException('device_offline');
    const p = this.providers(deviceId).find(p => p.provider === provider);
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
  private turnPayload(r: AIResource): AiTurn { return {id:r.id,sessionId:r.sessionId,input:r.input!,output:r.output!}; }
  private finish(r: AIResource, code: string, outcome: 'unknown' | 'confirmed' | 'not_started' = 'unknown'): void {
    r.status = r.kind === 'conversation' ? 'closed':'failed'; r.finishedAt = new Date().toISOString();
    r.waitingFor = null; r.activeTurnId = null; r.error = {code,message:code,executionOutcome:outcome};
  }
  private send(deviceId: string, type: string, payload: unknown): boolean {
    try { const client = this.registry.getClient(deviceId); if (!client || client.readyState !== 1) return false;
      client.send(JSON.stringify({event:'message',data:{type,protocolVersion:'2',messageId:randomUUID(),deviceId,sentAt:new Date().toISOString(),payload}})); return true;
    } catch (reason) { this.logger.error(`AI command ${type} failed for device ${deviceId}: ${String(reason)}`); return false; }
  }
}
