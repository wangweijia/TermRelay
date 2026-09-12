import { Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type {
  Envelope,
  ProtocolErrorCode,
  ProtocolErrorPayload,
} from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type {
  SessionEventRecord,
  SessionRecord,
} from '../sessions/session.repository';
import {
  SessionsService,
  type SessionEventNotification,
} from '../sessions/sessions.service';
import { BrowserProtocolValidator } from './browser-protocol-validator';
import { CommandRelayService } from './command-relay.service';

interface BrowserSubscription {
  ready: boolean;
  lastSeq: number;
  buffered: Map<number, SessionEventNotification>;
}

interface SessionSubscribedPayload {
  session: SessionRecord;
  events: SessionEventRecord[];
  latestSeq: number;
}

@WebSocketGateway({ path: '/ws/web' })
export class BrowserGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BrowserGateway.name);
  private readonly browsers = new Map<
    WebSocket,
    Map<string, BrowserSubscription>
  >();
  private readonly maxSubscriptions = readPositiveInteger(
    'WEB_MAX_SESSION_SUBSCRIPTIONS',
    16,
  );
  private readonly maxReplayEvents = readPositiveInteger(
    'WEB_MAX_REPLAY_EVENTS',
    10_000,
  );
  private readonly pingIntervalMs = readPositiveInteger(
    'WEB_SOCKET_PING_INTERVAL_MS',
    25_000,
  );
  private unsubscribeEvents?: () => void;
  private unsubscribeStates?: () => void;
  private pingTimer?: NodeJS.Timeout;

  constructor(
    private readonly validator: BrowserProtocolValidator,
    private readonly sessions: SessionsService,
    @Optional() private readonly commands?: CommandRelayService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeEvents = this.sessions.subscribe((notification) => {
      this.broadcast(notification);
    });
    this.unsubscribeStates = this.sessions.subscribeState((session) => {
      this.broadcastSessionState(session);
    });
    this.pingTimer = setInterval(() => this.pingBrowsers(), this.pingIntervalMs);
    this.pingTimer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    this.unsubscribeStates?.();
    this.unsubscribeStates = undefined;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  handleConnection(client: WebSocket): void {
    // TODO: reject unless a verified Cloudflare Access identity is attached.
    this.browsers.set(client, new Map());
  }

  handleDisconnect(client: WebSocket): void {
    this.browsers.delete(client);
  }

  private pingBrowsers(): void {
    for (const client of this.browsers.keys()) {
      try {
        client.ping();
      } catch {
        this.browsers.delete(client);
      }
    }
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() input: unknown,
  ): Promise<void> {
    const result = this.validator.validate(input);
    if (!result.ok) {
      this.sendProtocolError(
        client,
        result.code,
        result.detail,
        result.relatedMessageId,
      );
      if (result.code === 'unsupported_version') {
        client.close(1002, 'unsupported protocol version');
      }
      return;
    }

    const { envelope } = result.message;
    if (
      result.message.type === 'terminal.input' ||
      result.message.type === 'terminal.resize' ||
      result.message.type === 'session.interrupt' ||
      result.message.type === 'session.stop' ||
      result.message.type === 'tool.turn.start' ||
      result.message.type === 'tool.turn.interrupt' ||
      result.message.type === 'tool.approval.resolve'
    ) {
      if (!this.commands) {
        this.sendProtocolError(client, 'internal_error', 'Command relay is unavailable.', envelope.messageId);
        return;
      }
      const routed = await this.commands.route(
        client,
        envelope as unknown as Envelope<Record<string, unknown>>,
      );
      if (!routed.ok) {
        this.sendProtocolError(
          client,
          routed.code,
          routed.detail,
          envelope.messageId,
        );
      }
      return;
    }

    if (result.message.type === 'session.unsubscribe') {
      this.browsers.get(client)?.delete(envelope.sessionId!);
      this.sendEnvelope(client, {
        type: 'session.unsubscribed',
        protocolVersion: '1',
        messageId: randomUUID(),
        deviceId: envelope.deviceId,
        sessionId: envelope.sessionId,
        sentAt: new Date().toISOString(),
        payload: {},
      });
      return;
    }

    const subscribeEnvelope = result.message.type === 'session.subscribe'
      ? result.message.envelope
      : undefined;
    if (!subscribeEnvelope) return;
    await this.subscribeSession(
      client,
      subscribeEnvelope.deviceId,
      subscribeEnvelope.sessionId!,
      subscribeEnvelope.payload.afterSeq ?? -1,
      subscribeEnvelope.messageId,
    );
  }

  private async subscribeSession(
    client: WebSocket,
    deviceId: string,
    sessionId: string,
    afterSeq: number,
    relatedMessageId: string,
  ): Promise<void> {
    const subscriptions = this.browsers.get(client);
    if (!subscriptions) return;
    if (!subscriptions.has(sessionId) && subscriptions.size >= this.maxSubscriptions) {
      this.sendProtocolError(
        client,
        'conflict',
        `A browser may subscribe to at most ${this.maxSubscriptions} sessions.`,
        relatedMessageId,
      );
      return;
    }

    const session = await this.sessions.findById(sessionId);
    if (!session || session.deviceId !== deviceId) {
      this.sendProtocolError(
        client,
        'unknown_session',
        'Session does not exist for the requested device.',
        relatedMessageId,
      );
      return;
    }

    const subscription: BrowserSubscription = {
      ready: false,
      lastSeq: afterSeq,
      buffered: new Map(),
    };
    subscriptions.set(sessionId, subscription);

    try {
      const events = await this.loadReplayEvents(sessionId, afterSeq);
      if (!events) {
        subscriptions.delete(sessionId);
        this.sendProtocolError(
          client,
          'conflict',
          `Session replay exceeds ${this.maxReplayEvents} events; reconnect from a newer sequence.`,
          relatedMessageId,
        );
        return;
      }
      const latestSeq = Math.max(
        afterSeq,
        session.stateVersion,
        ...events.map((event) => event.seq),
      );
      this.sendEnvelope<SessionSubscribedPayload>(client, {
        type: 'session.subscribed',
        protocolVersion: '1',
        messageId: randomUUID(),
        deviceId,
        sessionId,
        seq: latestSeq,
        sentAt: new Date().toISOString(),
        payload: { session, events, latestSeq },
      });
      subscription.lastSeq = latestSeq;
      subscription.ready = true;

      for (const notification of [...subscription.buffered.values()].sort(
        (left, right) => left.event.seq - right.event.seq,
      )) {
        this.sendLiveEvent(client, subscription, notification);
      }
      subscription.buffered.clear();
    } catch (error: unknown) {
      subscriptions.delete(sessionId);
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to subscribe session ${sessionId}: ${detail}`);
      this.sendProtocolError(
        client,
        'internal_error',
        'Failed to load the session snapshot.',
        relatedMessageId,
      );
    }
  }

  private async loadReplayEvents(
    sessionId: string,
    afterSeq: number,
  ): Promise<SessionEventRecord[] | undefined> {
    const events: SessionEventRecord[] = [];
    let cursor = afterSeq;
    while (events.length < this.maxReplayEvents) {
      const remaining = this.maxReplayEvents - events.length;
      const pageSize = Math.min(1_000, remaining);
      const page = await this.sessions.listEvents(sessionId, cursor, pageSize);
      if (!page) return [];
      events.push(...page);
      if (page.length < pageSize) return events;
      cursor = page.at(-1)!.seq;
    }
    const overflow = await this.sessions.listEvents(sessionId, cursor, 1);
    return overflow?.length ? undefined : events;
  }

  private broadcast(notification: SessionEventNotification): void {
    for (const [client, subscriptions] of this.browsers) {
      const subscription = subscriptions.get(notification.sessionId);
      if (!subscription) continue;
      if (!subscription.ready) {
        subscription.buffered.set(notification.event.seq, notification);
        continue;
      }
      this.sendLiveEvent(client, subscription, notification);
    }
  }

  private sendLiveEvent(
    client: WebSocket,
    subscription: BrowserSubscription,
    notification: SessionEventNotification,
  ): void {
    if (notification.event.seq <= subscription.lastSeq) return;
    this.sendEnvelope(client, {
      type: notification.event.type,
      protocolVersion: '1',
      messageId: randomUUID(),
      deviceId: notification.deviceId,
      sessionId: notification.sessionId,
      seq: notification.event.seq,
      sentAt: notification.event.createdAt,
      payload: notification.event.payload,
    });
    subscription.lastSeq = notification.event.seq;
  }

  private broadcastSessionState(session: SessionRecord): void {
    for (const client of this.browsers.keys()) {
      this.sendEnvelope(client, {
        type: 'session.updated',
        protocolVersion: '1',
        messageId: randomUUID(),
        deviceId: session.deviceId,
        sessionId: session.id,
        sentAt: session.updatedAt,
        payload: { session },
      });
    }
  }

  private sendProtocolError(
    client: WebSocket,
    code: ProtocolErrorCode,
    message: string,
    relatedMessageId?: string,
  ): void {
    this.sendEnvelope<ProtocolErrorPayload>(client, {
      type: 'protocol.error',
      protocolVersion: '1',
      messageId: randomUUID(),
      deviceId: 'web',
      sentAt: new Date().toISOString(),
      payload: {
        code,
        message: message.slice(0, 2_048),
        ...(relatedMessageId ? { relatedMessageId } : {}),
      },
    });
  }

  private sendEnvelope<TPayload>(
    client: WebSocket,
    envelope: Envelope<TPayload>,
  ): void {
    try {
      client.send(JSON.stringify({ event: 'message', data: envelope }));
    } catch {
      this.logger.warn(`Failed to send ${envelope.type} to a browser client.`);
    }
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
