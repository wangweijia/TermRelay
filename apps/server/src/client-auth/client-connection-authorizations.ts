import { Injectable } from '@nestjs/common';
import type WebSocket from 'ws';

export interface ClientConnectionAuthorization {
  credentialId: string;
  deviceId: string;
  expiresAt: Date | null;
}

@Injectable()
export class ClientConnectionAuthorizations {
  private readonly bySocket = new WeakMap<WebSocket, ClientConnectionAuthorization>();
  private readonly byCredential = new Map<string, Set<WebSocket>>();

  attach(socket: WebSocket, authorization: ClientConnectionAuthorization): void {
    this.bySocket.set(socket, authorization);
    const sockets = this.byCredential.get(authorization.credentialId) ?? new Set();
    sockets.add(socket);
    this.byCredential.set(authorization.credentialId, sockets);
  }

  get(socket: WebSocket): ClientConnectionAuthorization | undefined {
    return this.bySocket.get(socket);
  }

  detach(socket: WebSocket): void {
    const authorization = this.bySocket.get(socket);
    if (!authorization) return;
    this.bySocket.delete(socket);
    const sockets = this.byCredential.get(authorization.credentialId);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.byCredential.delete(authorization.credentialId);
  }

  socketsForCredential(credentialId: string): readonly WebSocket[] {
    return [...(this.byCredential.get(credentialId) ?? [])];
  }
}