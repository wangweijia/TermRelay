import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { ControllerConversationPayload, Envelope } from '@termrelay/contracts';
import { SessionsService } from '../sessions/sessions.service';
import type { SessionEventRecord, SessionRecord } from '../sessions/session.repository';
import { CommandRelayService } from '../realtime/command-relay.service';
import { TurnCommandRepository } from '../realtime/turn-command.repository';
import type { ControllerAuthorization } from './controller-auth.service';

interface Context {
  auth: ControllerAuthorization;
  active: () => Promise<boolean>;
  send: (op: string, sessionId: string, body: unknown, relatedMessageId?: string) => void;
}
interface Subscription {
  context: Context; sessionId: string; syncId: string; boundary: number; lastSeq: number;
  ready: boolean; invalid: boolean; dirty: boolean; flushing: boolean; timer?: NodeJS.Timeout;
  buffered: Map<number, number>; bytes: number;
  reviews: Map<number, { token: string; kind: string; id: string; turnId: string }>;
  reads: Map<number, number>;
}
const MAX_INLINE = 24 * 1024;
const MAX_PAGE = 96 * 1024;
const human = (event: SessionEventRecord) => ['approval.requested', 'user-input.requested'].includes(String(event.payload.kind));
const summary = (s: SessionRecord) => ({ id: s.id, deviceId: s.deviceId, workspaceId: s.workspaceId, toolKey: s.toolKey,
  displayName: s.displayName, runtimeMode: s.runtimeMode, status: s.status });

@Injectable()
export class ControllerConversationService implements OnModuleInit, OnModuleDestroy {
  private readonly subscriptions = new Map<WebSocket, Subscription>();
  private offEvents?: () => void;
  private offStates?: () => void;
  constructor(private readonly sessions: SessionsService, private readonly commands: CommandRelayService,
    private readonly records: TurnCommandRepository) {}

  onModuleInit() {
    this.offEvents = this.sessions.subscribe(notification => {
      for (const [socket, sub] of this.subscriptions) {
        if (sub.sessionId !== notification.sessionId || sub.invalid) continue;
        if (!sub.ready) {
          const size = Buffer.byteLength(JSON.stringify(notification.event));
          if (!sub.buffered.has(notification.event.seq)) { sub.buffered.set(notification.event.seq, size); sub.bytes += size; }
          if (sub.buffered.size > 256 || sub.bytes > 512 * 1024) { this.invalidate(socket, sub); continue; }
        }
        sub.dirty = true; if (sub.ready) this.schedule(socket, sub);
      }
    });
    this.offStates = this.sessions.subscribeState(session => {
      for (const [socket, sub] of this.subscriptions) if (sub.sessionId === session.id && !sub.invalid) {
        sub.dirty = true; if (sub.ready) this.schedule(socket, sub);
      }
    });
  }
  onModuleDestroy() { this.offEvents?.(); this.offStates?.(); for (const socket of this.subscriptions.keys()) this.close(socket); }
  close(socket: WebSocket) {
    const sub = this.subscriptions.get(socket); if (sub?.timer) clearTimeout(sub.timer);
    this.subscriptions.delete(socket);
  }
  private async owned(context: Context, id: string) {
    if (!context.auth.permissions.includes('sessions.read') || !await context.active()) return undefined;
    const session = await this.sessions.findById(id);
    return session?.runtimeMode === 'acp' && context.auth.deviceIds.includes(session.deviceId) ? session : undefined;
  }
  private async live(socket: WebSocket, sub: Subscription) {
    return this.subscriptions.get(socket) === sub && !sub.invalid && !!await this.owned(sub.context, sub.sessionId);
  }
  private writable(session: SessionRecord, auth?: ControllerAuthorization) {
    return session.origin !== 'external' && ['starting', 'running'].includes(session.status)
      && (!auth || auth.permissions.some(permission => ['turns.write', 'approvals.resolve', 'user-input.resolve'].includes(permission)));
  }
  private validRequest(event: SessionEventRecord) {
    const data = event.payload.data as Record<string, unknown>;
    return !data.expiresAt || (typeof data.expiresAt === 'string' && Date.parse(data.expiresAt) > Date.now());
  }
  private wireEvent(event: SessionEventRecord, sub: Subscription, review = false) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const result: Record<string, unknown> = { seq: event.seq, type: event.type, createdAt: event.createdAt,
      bytes, payload: bytes <= MAX_INLINE ? event.payload : null };
    if (review && bytes <= MAX_INLINE && human(event)) result.reviewToken = this.review(sub, event);
    return result;
  }
  private review(sub: Subscription, event: SessionEventRecord) {
    const data = event.payload.data as Record<string, unknown>;
    const prior = sub.reviews.get(event.seq);
    if (prior && prior.kind === event.payload.kind && prior.id === String(data.approvalId ?? data.requestId) && prior.turnId === data.turnId) return prior.token;
    if (sub.reviews.size >= 64) sub.reviews.delete(sub.reviews.keys().next().value!);
    const token = randomUUID();
    sub.reviews.set(event.seq, { token, kind: String(event.payload.kind), id: String(data.approvalId ?? data.requestId), turnId: String(data.turnId) });
    return token;
  }
  private page(events: SessionEventRecord[], sub: Subscription, newest: boolean, review = false) {
    const ordered = newest ? [...events].reverse() : events;
    const items: Record<string, unknown>[] = []; let bytes = 0;
    for (const event of ordered) {
      if (items.length === 20) break;
      const item = this.wireEvent(event, sub, review); const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > MAX_PAGE) break;
      bytes += size; items.push(item);
    }
    return newest ? items.reverse() : items;
  }
  async handle(socket: WebSocket, context: Context, envelope: Envelope<ControllerConversationPayload>): Promise<void> {
    const p = envelope.payload; const session = await this.owned(context, p.sessionId);
    if (!session) throw new Error('Resource is unavailable.');
    const respond = async (body: unknown, op = p.op) => {
      if (await this.owned(context, p.sessionId)) context.send(op, p.sessionId, body, envelope.messageId);
    };
    if (p.op === 'close') { this.close(socket); await respond({}); return; }
    if (p.op === 'status') {
      const record = await this.records.find(p.commandId!);
      if (!record || record.sessionId !== session.id || record.deviceId !== session.deviceId) throw new Error('Command result is unavailable.');
      await respond({ commandId: record.commandId, ack: record.ack }); return;
    }
    if (p.op === 'sync') {
      this.close(socket);
      const sub: Subscription = { context, sessionId: session.id, syncId: randomUUID(), boundary: 0, lastSeq: 0,
        ready: false, invalid: false, dirty: false, flushing: false, buffered: new Map(), bytes: 0, reviews: new Map(), reads: new Map() };
      this.subscriptions.set(socket, sub);
      const snapshot = await this.owned(context, session.id);
      if (!snapshot || !await this.live(socket, sub)) return;
      sub.boundary = snapshot.stateVersion; sub.lastSeq = sub.boundary;
      const source = await this.sessions.listEventsBefore(session.id, sub.boundary + 1, 21) ?? [];
      const items = this.page(source, sub, true);
      if (!await this.live(socket, sub)) return;
      await respond({ syncId: sub.syncId, boundary: sub.boundary, session: summary(snapshot), canWrite: this.writable(snapshot, context.auth),
        items, beforeSeq: items.length && Number(items[0]!.seq) > 0 ? items[0]!.seq : null }); return;
    }
    const sub = this.subscriptions.get(socket);
    if (!sub || sub.sessionId !== session.id || sub.syncId !== p.syncId || !await this.live(socket, sub)) throw new Error('Resynchronize this conversation.');
    if (p.op === 'ready') {
      sub.ready = true; sub.buffered.clear(); sub.bytes = 0;
      await respond({ syncId: sub.syncId }); this.schedule(socket, sub); return;
    }
    if (p.op === 'history') {
      const source = await this.sessions.listEventsBefore(session.id, Math.min(p.beforeSeq!, sub.boundary + 1), 21) ?? [];
      const items = this.page(source, sub, true);
      if (await this.live(socket, sub)) await respond({ syncId: sub.syncId, items,
        beforeSeq: items.length && Number(items[0]!.seq) > 0 ? items[0]!.seq : null }); return;
    }
    if (p.op === 'requests') {
      const source = await this.sessions.listHumanRequests(session.id, p.beforeSeq, 21);
      const items = this.page(source.filter(event => this.validRequest(event)), sub, false, true);
      if (await this.live(socket, sub)) await respond({ syncId: sub.syncId, items,
        beforeSeq: source.length >= 20 ? (items.at(-1)?.seq ?? source.at(-1)!.seq) : null }); return;
    }
    if (p.op === 'event') {
      const source = await this.sessions.listEvents(session.id, p.seq! - 1, 1);
      const event = source?.[0];
      if (!event || event.seq !== p.seq || event.type !== 'tool.event') throw new Error('Event is unavailable.');
      const bytes = Buffer.from(JSON.stringify(event));
      if (p.offset! > bytes.length) throw new Error('Invalid event offset.');
      if (p.offset === 0) {
        if (sub.reads.size >= 4) sub.reads.delete(sub.reads.keys().next().value!);
        sub.reads.set(event.seq, 0);
      }
      if (sub.reads.get(event.seq) !== p.offset) throw new Error('Read the event from the beginning in order.');
      const end = Math.min(p.offset! + 24 * 1024, bytes.length);
      if (await this.live(socket, sub)) {
        sub.reads.set(event.seq, end);
        await respond({ syncId: sub.syncId, seq: event.seq, offset: p.offset, total: bytes.length,
        data: bytes.subarray(p.offset, end).toString('base64'), final: end === bytes.length,
        ...(end === bytes.length && human(event) ? { reviewToken: this.review(sub, event) } : {}) });
        if (end === bytes.length) sub.reads.delete(event.seq);
      }
      return;
    }
    if (p.op === 'command') {
      if (!sub.ready) throw new Error('Conversation is synchronizing.');
      const permission = p.type === 'tool.approval.resolve' ? 'approvals.resolve' : p.type === 'tool.user-input.resolve' ? 'user-input.resolve' : 'turns.write';
      const authorize = async () => {
        const current = await this.owned(context, session.id);
        if (!current || !this.writable(current) || !context.auth.permissions.includes(permission) || !await this.live(socket, sub)) return false;
        if (p.type === 'tool.approval.resolve' || p.type === 'tool.user-input.resolve') {
          const kind = p.type === 'tool.approval.resolve' ? 'approval.requested' : 'user-input.requested';
          const data = p.data!;
          const request = await this.sessions.findHumanRequest(session.id, { kind, id: String(data.approvalId ?? data.requestId), turnId: String(data.turnId) });
          if (!request || !this.validRequest(request) || (kind === 'approval.requested' && current.autoApproveEnabled)) return false;
          if (data.decision === 'allowOnce' || kind === 'user-input.requested') {
            const reviewed = sub.reviews.get(request.seq);
            if (!reviewed || reviewed.token !== p.reviewToken || reviewed.kind !== kind || reviewed.id !== String(data.approvalId ?? data.requestId)
              || reviewed.turnId !== data.turnId) return false;
          }
          if (kind === 'user-input.requested' && !this.answersValid(request, data.answers as Record<string, string[]>)) return false;
        }
        return await context.active();
      };
      if (!await authorize()) throw new Error('Request is no longer actionable or permission is missing.');
      const relaySocket = { send: (serialized: string) => {
        const ack = JSON.parse(serialized).data as Envelope<unknown>;
        void this.owned(context, session.id).then(current => {
          if (current) context.send('ack', session.id, { commandId: p.commandId, ack: ack.payload });
        }).catch(() => undefined);
      } } as unknown as WebSocket;
      const routed = await this.commands.route(relaySocket, { type: p.type!, protocolVersion: '2', messageId: envelope.messageId,
        deviceId: session.deviceId, sessionId: session.id, commandId: p.commandId, sentAt: envelope.sentAt, payload: p.data! }, { authorize, persist: true });
      if (!routed.ok) throw new Error(routed.detail);
      await respond({ commandId: p.commandId, dispatched: true });
    }
  }
  private answersValid(request: SessionEventRecord, answers: Record<string, string[]>) {
    const questions = (request.payload.data as { questions?: Array<Record<string, unknown>> }).questions;
    if (!Array.isArray(questions) || questions.length !== Object.keys(answers).length) return false;
    return questions.every(question => {
      const selected = answers[String(question.id)];
      if (!Array.isArray(selected) || !selected.length || (question.allowsMultiple !== true && selected.length !== 1)) return false;
      const options = Array.isArray(question.options) ? question.options as { label: string }[] : [];
      return new Set(selected).size === selected.length && selected.every(value => question.allowsOther === true || !options.length || options.some(option => option.label === value));
    });
  }
  private invalidate(socket: WebSocket, sub: Subscription) {
    sub.invalid = true; sub.buffered.clear(); sub.bytes = 0;
    if (sub.timer) clearTimeout(sub.timer);
    void this.owned(sub.context, sub.sessionId).then(session => {
      if (session && this.subscriptions.get(socket) === sub) sub.context.send('resync', sub.sessionId, { reason: 'buffer_or_history_gap' });
    }).catch(() => undefined);
  }
  private schedule(socket: WebSocket, sub: Subscription) {
    if (sub.flushing) { sub.dirty = true; return; }
    if (sub.timer || sub.invalid || !sub.ready) return;
    sub.timer = setTimeout(() => {
      sub.timer = undefined;
      sub.flushing = true;
      void this.flush(socket, sub).catch(() => this.invalidate(socket, sub)).finally(() => {
        sub.flushing = false;
        if (sub.dirty && this.subscriptions.get(socket) === sub) this.schedule(socket, sub);
      });
    }, 100);
    sub.timer.unref();
  }
  private async flush(socket: WebSocket, sub: Subscription) {
    if (!await this.live(socket, sub)) return;
    sub.dirty = false;
    const source = await this.sessions.listEvents(sub.sessionId, sub.lastSeq, 20) ?? [];
    const items = this.page(source, sub, false);
    let next = sub.lastSeq;
    for (const item of items) { if (Number(item.seq) !== next + 1) { this.invalidate(socket, sub); return; } next++; }
    const session = await this.owned(sub.context, sub.sessionId);
    if (!session || !await this.live(socket, sub)) return;
    if (!items.length && session.stateVersion > sub.lastSeq) { this.invalidate(socket, sub); return; }
    sub.context.send('events', sub.sessionId, { syncId: sub.syncId, items, throughSeq: next,
      session: summary(session), canWrite: this.writable(session, sub.context.auth), requestsChanged: source.some(human)
        || source.some(event => ['approval.resolved', 'user-input.resolved', 'turn.completed'].includes(String(event.payload.kind))) });
    sub.lastSeq = next;
    if (source.length === 20 || items.length < source.length || sub.dirty || next < session.stateVersion) this.schedule(socket, sub);
  }
}
