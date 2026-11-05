import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  controllerMeGetSchema, controllerDevicesListSchema, controllerSessionsListSchema,
  type ControllerDevicesListPayload, type ControllerSessionsListPayload,
  type ControllerDeviceSummary, type ControllerSessionSummary,
} from '@termrelay/contracts';
import { DevicesService } from '../devices/devices.service';
import { SessionsService } from '../sessions/sessions.service';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import { ControllerAuthService, type ControllerAuthorization } from './controller-auth.service';

@Injectable()
export class ControllerConnections implements OnModuleDestroy {
  private readonly connections = new Map<WebSocket, ControllerAuthorization>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private readonly budgets = new WeakMap<WebSocket, { start: number; count: number; pending: number }>();
  private readonly validator = new ProtocolSchemaValidator('client', {
    'controller.me.get': controllerMeGetSchema,
    'controller.devices.list': controllerDevicesListSchema,
    'controller.sessions.list': controllerSessionsListSchema,
  });
  private readonly heartbeat = setInterval(() => {
    for (const socket of this.connections.keys()) {
      if (this.awaitingPong.has(socket)) { socket.terminate(); continue; }
      this.awaitingPong.add(socket);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, 25_000);

  constructor(
    private readonly auth: ControllerAuthService,
    private readonly devices: DevicesService,
    private readonly sessions: SessionsService,
  ) { this.heartbeat.unref(); }
  attach(socket: WebSocket, authorization: ControllerAuthorization) {
    this.connections.set(socket, authorization);
    this.budgets.set(socket, { start: Date.now(), count: 0, pending: 0 });
    socket.once('close', () => this.connections.delete(socket));
    socket.on('pong', () => this.awaitingPong.delete(socket));
  }
  get(socket: WebSocket) { return this.connections.get(socket); }
  async connected(socket: WebSocket, relatedMessageId?: string) {
    const authorization = this.get(socket);
    if (!authorization) return;
    if (!await this.auth.isActive(authorization.credentialId)) { socket.close(4003, 'authorization revoked'); return; }
    if (this.get(socket) === authorization) this.send(socket, 'controller.connected', authorization.installationId, {
      role: 'controller', installationId: authorization.installationId, deviceIds: authorization.deviceIds,
      permissions: authorization.permissions, expiresAt: null,
      capabilities: ['devices.list', 'sessions.list'],
      ...(relatedMessageId ? { relatedMessageId } : {}),
    });
  }
  async message(socket: WebSocket, input: unknown) {
    const authorization = this.get(socket);
    if (!authorization) return;
    const budget = this.budgets.get(socket)!;
    if (Date.now() - budget.start >= 10_000) { budget.start = Date.now(); budget.count = 0; }
    if (++budget.count > 30 || budget.pending >= 2) { socket.close(1013, 'controller query limit'); return; }
    const result = this.validator.validate(input);
    if (!result.ok) {
      this.send(socket, 'protocol.error', authorization.installationId, {
        code: result.code, message: result.detail,
        ...(result.relatedMessageId ? { relatedMessageId: result.relatedMessageId } : {}),
      });
      return;
    }
    const { envelope, type } = result.message;
    const fail = (code: string, message: string) => this.send(socket, 'protocol.error', authorization.installationId, {
      code, message, relatedMessageId: envelope.messageId,
    });
    if (envelope.deviceId !== authorization.installationId || envelope.sessionId !== undefined
      || envelope.commandId !== undefined || envelope.seq !== undefined) {
      fail('invalid_message', 'Controller queries require only the authenticated installation identity.'); return;
    }
    budget.pending++;
    try {
      if (!await this.active(socket, authorization)) return;
      if (type === 'controller.me.get') { await this.connected(socket, envelope.messageId); return; }
      if (!authorization.permissions.includes('sessions.read')) {
        fail('unknown_device', 'Resource is unavailable.'); return;
      }
      const payload = envelope.payload as ControllerDevicesListPayload;
      const limit = payload.limit ?? 20;
      if (type === 'controller.devices.list') {
        const records = (await this.devices.list())
          .filter(record => authorization.deviceIds.includes(record.id) && (!payload.cursor || record.id > payload.cursor))
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const items: ControllerDeviceSummary[] = records.slice(0, limit).map(({ id, name, status, platform }) => ({ id, name, status, platform }));
        if (await this.active(socket, authorization)) this.send(socket, 'controller.devices.listed', authorization.installationId, {
          relatedMessageId: envelope.messageId, items, nextCursor: records.length > limit ? items.at(-1)!.id : null,
        });
      } else {
        const { deviceId, cursor } = envelope.payload as ControllerSessionsListPayload;
        if (!authorization.deviceIds.includes(deviceId)) { fail('unknown_device', 'Resource is unavailable.'); return; }
        const records = await this.sessions.listControllerSessions(deviceId, cursor, limit + 1);
        const items: ControllerSessionSummary[] = records.slice(0, limit).map(({ id, deviceId, workspaceId, toolKey, displayName, runtimeMode, status }) =>
          ({ id, deviceId, workspaceId, toolKey, displayName, runtimeMode, status }));
        if (await this.active(socket, authorization)) this.send(socket, 'controller.sessions.listed', authorization.installationId, {
          relatedMessageId: envelope.messageId, deviceId, items, nextCursor: records.length > limit ? items.at(-1)!.id : null,
        });
      }
    } finally { budget.pending--; }
  }
  private async active(socket: WebSocket, authorization: ControllerAuthorization): Promise<boolean> {
    if (!await this.auth.isActive(authorization.credentialId)) { socket.close(4003, 'authorization revoked'); return false; }
    return this.get(socket) === authorization && socket.readyState === 1;
  }
  revoke(id: string) {
    for (const [socket, authorization] of this.connections) {
      if (authorization.credentialId !== id) continue;
      this.connections.delete(socket);
      this.send(socket, 'controller.authorization-revoked', authorization.installationId, { reason: 'revoked', revokedAt: new Date().toISOString() });
      socket.close(4003, 'authorization revoked');
    }
  }
  onModuleDestroy() {
    clearInterval(this.heartbeat);
    for (const socket of this.connections.keys()) socket.close(1001, 'server shutdown');
    this.connections.clear();
  }
  private send(socket: WebSocket, type: string, deviceId: string, payload: unknown) {
    if (socket.readyState !== 1) return;
    const serialized = JSON.stringify({ type, protocolVersion: '2', messageId: randomUUID(), deviceId, sentAt: new Date().toISOString(), payload });
    if (Buffer.byteLength(serialized) > 128 * 1024 || socket.bufferedAmount > 256 * 1024) {
      socket.close(1013, 'controller response budget'); return;
    }
    socket.send(serialized);
  }
}
