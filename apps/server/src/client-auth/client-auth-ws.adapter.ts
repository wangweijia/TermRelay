import type { INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import type { IncomingMessage } from 'node:http';
import type WebSocket from 'ws';
import { ClientAuthService, type CredentialValidationResult } from './client-auth.service';
import { ClientConnectionAuthorizations } from './client-connection-authorizations';
import { ClientAuthRateLimiter, clientAddress } from './client-auth-rate-limiter';
import { ControllerAuthService, type ControllerAuthorization } from './controller-auth.service';
import { ControllerConnections } from './controller-connections';

const PUBLIC_CLIENT_PATH = '/ws/client-public';
const MAX_AUTHORIZATION_LENGTH = 256;
const requestAuthorizations = new WeakMap<IncomingMessage, CredentialValidationResult & { ok: true }>();
const controllerAuthorizations = new WeakMap<IncomingMessage, ControllerAuthorization>();

interface VerifyClientInfo {
  req: IncomingMessage;
}

type VerifyClientDone = (result: boolean, code?: number, message?: string) => void;

export class ClientAuthWsAdapter extends WsAdapter {
  private readonly auth: ClientAuthService;
  private readonly connections: ClientConnectionAuthorizations;
  private readonly rateLimiter: ClientAuthRateLimiter;
  private readonly controllerAuth: ControllerAuthService;
  private readonly controllers: ControllerConnections;

  constructor(app: INestApplicationContext) {
    super(app);
    this.auth = app.get(ClientAuthService);
    this.connections = app.get(ClientConnectionAuthorizations);
    this.rateLimiter = app.get(ClientAuthRateLimiter);
    this.controllerAuth = app.get(ControllerAuthService);
    this.controllers = app.get(ControllerConnections);
  }

  override create(
    port: number,
    options?: Record<string, unknown> & { namespace?: string; server?: unknown; path?: string },
  ): unknown {
    if (options?.path !== PUBLIC_CLIENT_PATH) return super.create(port, options);

    const server = super.create(port, {
      ...options,
      verifyClient: (info: VerifyClientInfo, done: VerifyClientDone) => {
        void this.authorize(info.req, done);
      },
    }) as WebSocket.Server;
    server.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const controller = controllerAuthorizations.get(request);
      controllerAuthorizations.delete(request);
      if (controller) this.controllers.attach(socket, controller);
      const authorization = requestAuthorizations.get(request);
      requestAuthorizations.delete(request);
      if (authorization) this.connections.attach(socket, authorization);
    });
    return server;
  }

  private async authorize(request: IncomingMessage, done: VerifyClientDone): Promise<void> {
    const address = clientAddress(request.headers, request.socket.remoteAddress ?? 'unknown');
    if (!this.rateLimiter.consume(`websocket:${address}`, 60, 60_000)) {
      done(false, 429, 'Too Many Requests');
      return;
    }
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_LENGTH) {
      done(false, 401, 'Unauthorized');
      return;
    }
    try {
      if (header.startsWith('Bearer tr_controller_')) {
        const authorization = await this.controllerAuth.validate(header);
        if (!authorization) { done(false, 401, 'Unauthorized'); return; }
        controllerAuthorizations.set(request, authorization);
        done(true);
        return;
      }
      const authorization = await this.auth.validateCredential(header);
      if (!authorization.ok) {
        done(false, 401, 'Unauthorized');
        return;
      }
      requestAuthorizations.set(request, authorization);
      done(true);
    } catch {
      done(false, 503, 'Service Unavailable');
    }
  }
}