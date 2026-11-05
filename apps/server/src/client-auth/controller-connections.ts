import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { controllerMeGetSchema } from '@termrelay/contracts';
import { ProtocolSchemaValidator } from '../realtime/protocol-schema-validator';
import { ControllerAuthService, type ControllerAuthorization } from './controller-auth.service';

@Injectable()
export class ControllerConnections implements OnModuleDestroy {
  private readonly connections = new Map<WebSocket, ControllerAuthorization>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private readonly validator = new ProtocolSchemaValidator('client', { 'controller.me.get': controllerMeGetSchema });
  private readonly heartbeat = setInterval(() => {
    for (const socket of this.connections.keys()) {
      if (this.awaitingPong.has(socket)) { socket.terminate(); continue; }
      this.awaitingPong.add(socket);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }, 25_000);

  constructor(private readonly auth: ControllerAuthService) { this.heartbeat.unref(); }
  attach(socket: WebSocket, authorization: ControllerAuthorization) {
    this.connections.set(socket, authorization);
    socket.once('close', () => this.connections.delete(socket));
    socket.on('pong', () => this.awaitingPong.delete(socket));
  }
  get(socket: WebSocket) { return this.connections.get(socket); }
  async connected(socket: WebSocket) {
    const authorization = this.get(socket);
    if (!authorization) return;
    if (!await this.auth.isActive(authorization.credentialId)) { socket.close(4003, 'authorization revoked'); return; }
    if (this.get(socket) === authorization) this.send(socket, 'controller.connected', authorization.installationId, {
      role: 'controller', installationId: authorization.installationId, deviceIds: authorization.deviceIds,
      permissions: authorization.permissions, expiresAt: null,
    });
  }
  async message(socket: WebSocket, input: unknown) {
    const authorization = this.get(socket);
    if (!authorization) return;
    const result = this.validator.validate(input);
    if (!result.ok || result.message.envelope.deviceId !== authorization.installationId) {
      this.send(socket, 'protocol.error', authorization.installationId, {
        code: 'invalid_message', detail: 'This controller connection only supports controller.me.get during authorization.',
      });
      return;
    }
    await this.connected(socket);
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
    socket.send(JSON.stringify({ type, protocolVersion: '2', messageId: randomUUID(), deviceId, sentAt: new Date().toISOString(), payload }));
  }
}