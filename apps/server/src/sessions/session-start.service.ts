import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
  type OnModuleDestroy, type OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import { sessionStartSchema, type CommandAckPayload, type Envelope, type SessionStartPayload } from '@termrelay/contracts';
import type WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import { WorkspaceRepository } from './workspace.repository';
import { SessionStartRepository } from './session-start.repository';
import { SessionsService } from './sessions.service';
import type { SessionStartEntity } from './session-start.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNKNOWN = '创建结果未知；请刷新会话列表核实。相同请求不会再次启动进程。';
const validate = new Ajv2020({ strict: true }).compile<SessionStartPayload>(sessionStartSchema);

@Injectable()
export class SessionStartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionStartService.name);
  private readonly queues = new Map<string, Promise<void>>();
  private unsubscribe?: () => void;

  constructor(
    private readonly store: SessionStartRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly registry: DeviceConnectionRegistry,
    private readonly sessions: SessionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.workspaces.enabled) await this.store.markUnknown();
    this.unsubscribe = this.registry.subscribe(device => {
      if (device.presence === 'offline') void this.disconnected(device.deviceId).catch(error => this.logger.error(String(error)));
    });
  }

  onModuleDestroy(): void { this.unsubscribe?.(); }

  async disconnected(deviceId: string): Promise<void> {
    if (this.workspaces.enabled) await this.store.markUnknown(deviceId);
  }

  async isCreationID(id: string): Promise<boolean> {
    return this.workspaces.enabled && (await this.store.find(id.toLowerCase())) !== null;
  }

  async targets() {
    const workspaces = await this.workspaces.listRemote();
    return workspaces.flatMap(workspace => {
      if (!this.registry.getClient(workspace.deviceId) || !workspace.launchOptions?.length) return [];
      return [{
        deviceId: workspace.deviceId, workspaceId: workspace.id,
        displayName: workspace.displayName, launchOptions: workspace.launchOptions,
      }];
    });
  }

  async create(input: unknown): Promise<SessionStartEntity> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid creation request.');
    const { requestId, deviceId, ...payload } = input as Record<string, unknown>;
    if (typeof requestId !== 'string' || !UUID.test(requestId) || typeof deviceId !== 'string'
      || !deviceId || deviceId.length > 128 || !validate(payload)) throw new BadRequestException('Invalid creation request.');
    const id = requestId.toLowerCase();
    const prior = this.queues.get(deviceId) ?? Promise.resolve();
    const task = prior.then(() => this.launch(id, deviceId, payload));
    const settled = task.then(() => undefined, () => undefined);
    this.queues.set(deviceId, settled);
    void settled.then(() => { if (this.queues.get(deviceId) === settled) this.queues.delete(deviceId); });
    return task;
  }

  async get(id: string): Promise<SessionStartEntity> {
    if (!UUID.test(id)) throw new BadRequestException('Invalid request ID.');
    let request = await this.store.find(id.toLowerCase());
    if (!request) throw new NotFoundException('Creation request not found.');
    if (['pending', 'accepted', 'unknown'].includes(request.status)) {
      const session = await this.sessions.findById(request.id);
      if (session && session.deviceId === request.deviceId && session.workspaceId === request.request.workspaceId
        && session.toolKey === request.request.toolKey && session.runtimeMode === request.request.runtimeMode
        && session.origin !== 'external') {
        await this.store.update(request.id, 'completed', null);
      } else if (request.status !== 'unknown' && Date.now() - request.createdAt.getTime() >= 60_000) {
        await this.store.update(request.id, 'unknown', UNKNOWN);
      }
      request = (await this.store.find(request.id))!;
    }
    return request;
  }

  async acknowledge(client: WebSocket, envelope: Envelope<CommandAckPayload>): Promise<boolean> {
    if (envelope.commandId?.toLowerCase() !== envelope.sessionId?.toLowerCase()) return false;
    const request = await this.store.find(envelope.commandId!.toLowerCase());
    if (!request) return false;
    if (request.deviceId !== envelope.deviceId || !this.registry.isRegisteredClient(client, envelope.deviceId)) {
      throw new ConflictException('Creation acknowledgement belongs to another device connection.');
    }
    const status = envelope.payload.status;
    if (status === 'accepted') await this.store.update(request.id, 'accepted', null);
    else if (status === 'completed') {
      const result = await this.get(request.id);
      if (result.status !== 'completed') await this.store.update(request.id, 'unknown', UNKNOWN);
    } else {
      await this.store.update(request.id, 'failed', envelope.payload.message?.slice(0, 2048) ?? 'Device rejected session creation.');
    }
    return true;
  }

  private async launch(id: string, deviceId: string, payload: SessionStartPayload): Promise<SessionStartEntity> {
    const existing = await this.store.find(id);
    if (existing) {
      if (existing.deviceId !== deviceId || !sameRequest(existing.request, payload)) throw new ConflictException('Request ID is already bound to another creation request.');
      return this.get(id);
    }
    const workspace = await this.workspaces.findById(payload.workspaceId);
    if (!workspace || workspace.deviceId !== deviceId || !workspace.available || !workspace.remoteStartAllowed
      || !workspace.launchOptions?.some(option => option.toolKey === payload.toolKey && option.runtimeMode === payload.runtimeMode)) {
      throw new ConflictException('Workspace or tool/mode is not authorized for remote creation.');
    }
    const client = this.registry.getClient(deviceId);
    if (!client) throw new ServiceUnavailableException('Target device is offline.');
    if (await this.sessions.findById(id)) throw new ConflictException('Session ID already exists.');
    const active = (await this.sessions.list()).filter(s => s.deviceId === deviceId && ['starting', 'running', 'stopping'].includes(s.status)).length;
    if (active + await this.store.countPending(deviceId) >= 8) throw new ConflictException('Device has reached the eight-session creation limit.');
    if (!(await this.store.reserve(id, deviceId, payload))) {
      const reserved = await this.store.find(id);
      if (!reserved || reserved.deviceId !== deviceId || !sameRequest(reserved.request, payload)) throw new ConflictException('Request ID conflict.');
      return this.get(id);
    }
    try {
      if (this.registry.getClient(deviceId) !== client) throw new Error('Device connection changed before delivery.');
      client.send(JSON.stringify({ event: 'message', data: {
        type: 'session.start', protocolVersion: '2', messageId: randomUUID(), deviceId,
        sessionId: id, commandId: id, sentAt: new Date().toISOString(), payload,
      } }), error => {
        if (error) void this.store.update(id, 'unknown', UNKNOWN).catch(failure => this.logger.error(String(failure)));
      });
    } catch (error) {
      this.logger.warn(`Remote session delivery failed: ${String(error)}`);
      await this.store.update(id, 'unknown', UNKNOWN);
    }
    return this.get(id);
  }
}

function sameRequest(a: SessionStartPayload, b: SessionStartPayload): boolean {
  return a.workspaceId === b.workspaceId && a.toolKey === b.toolKey && a.runtimeMode === b.runtimeMode
    && a.rows === b.rows && a.columns === b.columns && a.displayName === b.displayName;
}
