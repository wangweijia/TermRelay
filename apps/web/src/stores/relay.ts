import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import {
  deleteSessionCache,
  loadSelectedSessionCache,
  loadSessionCache,
  saveSelectedSession,
  saveSessionCache,
} from '../cache/relay-cache';
import type {
  CommandAckPayload,
  DeviceRecord,
  NotificationSettings,
  PendingApprovalRecord,
  SessionEventRecord,
  SessionRecord,
  SessionSubscribedPayload,
  SessionUpdatedPayload,
  WireEnvelope,
} from '../types';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const INITIAL_HISTORY_EVENTS = 500;
const OLDER_HISTORY_PAGE_SIZE = 250;
const MAX_HISTORY_EVENTS = 2_000;
const MAX_CACHED_EVENTS = 1_000;
const MAX_MEMORY_SESSIONS = 5;
const SESSION_REFRESH_INTERVAL_MS = 5_000;
const CACHE_WRITE_DELAY_MS = 500;
const pendingRealtimeEvents = new Map<string, Map<number, SessionEventRecord>>();
const dirtyCacheSessions = new Set<string>();
let realtimeFlushFrame: number | undefined;
let cacheWriteTimer: number | undefined;

export const useRelayStore = defineStore('relay', {
  state: () => ({
    sessions: [] as SessionRecord[],
    devices: [] as DeviceRecord[],
    pendingApprovals: [] as PendingApprovalRecord[],
    notificationSettings: { enabled: false, configured: false } as NotificationSettings,
    selectedSessionId: undefined as string | undefined,
    eventsBySession: {} as Record<string, SessionEventRecord[]>,
    hasOlderBySession: {} as Record<string, boolean>,
    lastSeqBySession: {} as Record<string, number>,
    historyAccessOrder: [] as string[],
    connectionState: 'disconnected' as ConnectionState,
    loadingSessions: false,
    loadingHistory: false,
    loadingOlderHistory: false,
    error: undefined as string | undefined,
    socket: undefined as WebSocket | undefined,
    reconnectTimer: undefined as number | undefined,
    refreshTimer: undefined as number | undefined,
    reconnectAttempt: 0,
    selectionVersion: 0,
    scrollToLatestRevision: 0,
    stopped: false,
    commandStatus: undefined as string | undefined,
  }),

  getters: {
    selectedSession(state): SessionRecord | undefined {
      return state.sessions.find((item) => item.id === state.selectedSessionId);
    },
    selectedEvents(state): SessionEventRecord[] {
      return state.selectedSessionId
        ? state.eventsBySession[state.selectedSessionId] ?? []
        : [];
    },
    selectedSessionInteractive(state): boolean {
      const session = state.sessions.find((item) => item.id === state.selectedSessionId);
      if (!session || !['starting', 'running'].includes(session.status)) return false;
      return state.devices.some(
        (device) => device.id === session.deviceId && device.status === 'connected',
      );
    },
  },

  actions: {
    async initialize(): Promise<void> {
      this.stopped = false;
      try {
        const cached = await loadSelectedSessionCache();
        if (cached) {
          this.selectedSessionId = cached.sessionId;
          if (cached.session) this.sessions = [cached.session];
          this.eventsBySession[cached.sessionId] = cached.events;
          this.hasOlderBySession[cached.sessionId] = (cached.events[0]?.seq ?? 0) > 0;
          this.lastSeqBySession[cached.sessionId] = cached.lastSeq;
          this.touchHistory(cached.sessionId);
        }
      } catch {
        // IndexedDB is an optional fast path; private browsing or browser policy may disable it.
      }
      await this.refreshSessions();
      await this.loadNotificationSettings();
      if (!this.selectedSessionId && this.sessions[0]) {
        await this.selectSession(this.sessions[0].id);
      }
      this.connect();
      this.scheduleRefresh();
    },

    stop(): void {
      this.stopped = true;
      this.flushRealtimeEvents();
      void this.persistDirtyCaches();
      if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      this.socket?.close(1000, 'page closed');
      this.socket = undefined;
      this.connectionState = 'disconnected';
    },

    async refreshSessions(): Promise<void> {
      this.loadingSessions = true;
      try {
        const [sessionsResponse, devicesResponse, approvalsResponse] = await Promise.all([
          fetch('/api/sessions'),
          fetch('/api/devices'),
          fetch('/api/sessions/approvals/pending'),
        ]);
        if (!sessionsResponse.ok) {
          throw new Error(`会话列表请求失败 (${sessionsResponse.status})`);
        }
        if (!devicesResponse.ok) {
          throw new Error(`设备列表请求失败 (${devicesResponse.status})`);
        }
        if (!approvalsResponse.ok) throw new Error(`审批列表请求失败 (${approvalsResponse.status})`);
        this.sessions = (await sessionsResponse.json()) as SessionRecord[];
        this.devices = (await devicesResponse.json()) as DeviceRecord[];
        this.pendingApprovals = (await approvalsResponse.json()) as PendingApprovalRecord[];
        if (
          this.selectedSessionId &&
          !this.sessions.some((item) => item.id === this.selectedSessionId)
        ) {
          void deleteSessionCache(this.selectedSessionId).catch(() => undefined);
          this.selectedSessionId = undefined;
        }
        this.error = undefined;
      } catch (error: unknown) {
        this.error = describeError(error);
      } finally {
        this.loadingSessions = false;
      }
    },

    async selectSession(sessionId: string): Promise<void> {
      if (
        sessionId === this.selectedSessionId &&
        Object.prototype.hasOwnProperty.call(this.eventsBySession, sessionId)
      ) {
        this.subscribeSelected();
        return;
      }
      const previous = this.selectedSession;
      if (previous) this.sendSubscription('session.unsubscribe', previous, {});

      const hasInMemoryHistory = Object.prototype.hasOwnProperty.call(
        this.eventsBySession,
        sessionId,
      );
      this.selectedSessionId = sessionId;
      this.touchHistory(sessionId);
      this.evictInactiveHistories();
      void saveSelectedSession(sessionId).catch(() => undefined);
      const version = ++this.selectionVersion;
      if (hasInMemoryHistory) {
        this.loadingHistory = false;
        this.error = undefined;
        this.subscribeSelected();
        this.scrollToLatestRevision += 1;
        return;
      }

      this.loadingHistory = true;
      try {
        const cached = await loadSessionCache(sessionId).catch(() => undefined);
        if (version !== this.selectionVersion) return;
        if (cached) {
          const cachedEvents = cached.events.slice(-MAX_HISTORY_EVENTS);
          this.eventsBySession[sessionId] = cachedEvents;
          this.hasOlderBySession[sessionId] = (cachedEvents[0]?.seq ?? 0) > 0;
          this.lastSeqBySession[sessionId] = cached.lastSeq;
          this.error = undefined;
          this.subscribeSelected();
          return;
        }
        const history = await loadHistory(sessionId);
        if (version !== this.selectionVersion) return;
        this.eventsBySession[sessionId] = mergeEvents([], history);
        this.hasOlderBySession[sessionId] = history.length === INITIAL_HISTORY_EVENTS
          && (history[0]?.seq ?? 0) > 0;
        this.lastSeqBySession[sessionId] = history.at(-1)?.seq ?? -1;
        this.scheduleCachePersist(sessionId);
        this.error = undefined;
        this.subscribeSelected();
      } catch (error: unknown) {
        if (version === this.selectionVersion) this.error = describeError(error);
      } finally {
        if (version === this.selectionVersion) this.loadingHistory = false;
      }
    },

    async loadOlderHistory(): Promise<void> {
      const sessionId = this.selectedSessionId;
      if (!sessionId || this.loadingOlderHistory || !this.hasOlderBySession[sessionId]) return;
      const current = this.eventsBySession[sessionId] ?? [];
      const beforeSeq = current[0]?.seq;
      const available = MAX_HISTORY_EVENTS - current.length;
      if (beforeSeq === undefined || available <= 0) {
        this.hasOlderBySession[sessionId] = false;
        return;
      }

      this.loadingOlderHistory = true;
      try {
        const limit = Math.min(OLDER_HISTORY_PAGE_SIZE, available);
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/events?beforeSeq=${beforeSeq}&limit=${limit}`,
        );
        if (!response.ok) throw new Error(`更早历史请求失败 (${response.status})`);
        const page = (await response.json()) as SessionEventRecord[];
        if (sessionId !== this.selectedSessionId) return;
        this.eventsBySession[sessionId] = mergeEvents(page, current);
        this.hasOlderBySession[sessionId] = page.length === limit
          && (page[0]?.seq ?? 0) > 0
          && this.eventsBySession[sessionId]!.length < MAX_HISTORY_EVENTS;
        this.scheduleCachePersist(sessionId);
      } catch (error: unknown) {
        this.error = describeError(error);
      } finally {
        this.loadingOlderHistory = false;
      }
    },

    async deleteSession(sessionId: string, purge: boolean): Promise<boolean> {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (!session || session.status !== 'finished') {
        this.error = '只能删除已经结束的会话。';
        return false;
      }

      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}?purge=${purge}`,
          { method: 'DELETE' },
        );
        if (!response.ok) {
          throw new Error(await responseError(response, '删除会话失败'));
        }

        if (this.selectedSessionId === sessionId) {
          this.sendSubscription('session.unsubscribe', session, {});
          this.selectedSessionId = undefined;
          this.selectionVersion += 1;
          this.loadingHistory = false;
        }
        this.sessions = this.sessions.filter((item) => item.id !== sessionId);
        delete this.eventsBySession[sessionId];
        delete this.hasOlderBySession[sessionId];
        delete this.lastSeqBySession[sessionId];
        this.historyAccessOrder = this.historyAccessOrder.filter((id) => id !== sessionId);
        dirtyCacheSessions.delete(sessionId);
        void deleteSessionCache(sessionId).catch(() => undefined);
        this.commandStatus = undefined;
        this.error = undefined;

        if (!this.selectedSessionId && this.sessions[0]) {
          await this.selectSession(this.sessions[0].id);
        }
        return true;
      } catch (error: unknown) {
        this.error = describeError(error);
        return false;
      }
    },

    connect(): void {
      if (
        this.stopped ||
        this.socket?.readyState === WebSocket.OPEN ||
        this.socket?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }
      this.connectionState = 'connecting';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/web`);
      this.socket = markRaw(socket);

      socket.addEventListener('open', () => {
        if (this.socket !== socket) return;
        this.connectionState = 'connected';
        this.reconnectAttempt = 0;
        this.error = undefined;
        this.subscribeSelected();
      });
      socket.addEventListener('message', (event) => this.handleSocketMessage(event));
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.connectionState = 'disconnected';
        this.scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        if (this.socket === socket) this.error = '实时连接发生错误，正在重试。';
      });
    },

    subscribeSelected(): void {
      const session = this.selectedSession;
      if (!session) return;
      const events = this.eventsBySession[session.id] ?? [];
      const lastSeq = Math.max(
        events.at(-1)?.seq ?? -1,
        this.lastSeqBySession[session.id] ?? -1,
      );
      this.sendSubscription('session.subscribe', session, { afterSeq: lastSeq });
    },

    sendSubscription(
      type: 'session.subscribe' | 'session.unsubscribe',
      session: SessionRecord,
      payload: Record<string, unknown>,
    ): void {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const envelope: WireEnvelope = {
        type,
        protocolVersion: '2',
        messageId: createUuid(),
        deviceId: session.deviceId,
        sessionId: session.id,
        sentAt: new Date().toISOString(),
        payload,
      };
      this.socket.send(JSON.stringify({ event: 'message', data: envelope }));
    },

    sendCommand(
      type: 'terminal.input' | 'terminal.resize' | 'session.interrupt' | 'session.stop' | 'tool.turn.start' | 'tool.turn.interrupt' | 'tool.approval.resolve' | 'tool.user-input.resolve',
      payload: Record<string, unknown>,
    ): void {
      const session = this.selectedSession;
      if (!session) {
        this.error = '请先选择一个会话。';
        return;
      }
      this.sendCommandForSession(session.id, type, payload);
    },

    sendCommandForSession(
      sessionId: string,
      type: 'terminal.input' | 'terminal.resize' | 'session.interrupt' | 'session.stop' | 'tool.turn.start' | 'tool.turn.interrupt' | 'tool.approval.resolve' | 'tool.user-input.resolve',
      payload: Record<string, unknown>,
    ): void {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (!session) { this.error = '会话不存在。'; return; }
      if (!this.isSessionInteractive(session)) {
        this.error = '该会话当前不可操作：Mac 已离线或会话已经结束。';
        this.commandStatus = '命令未发送';
        return;
      }
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.error = 'Mac 命令无法发送：实时连接尚未建立。';
        return;
      }
      const commandId = createUuid();
      const envelope: WireEnvelope = {
        type,
        protocolVersion: '2',
        messageId: createUuid(),
        deviceId: session.deviceId,
        sessionId: session.id,
        commandId,
        sentAt: new Date().toISOString(),
        payload,
      };
      this.socket.send(JSON.stringify({ event: 'message', data: envelope }));
      this.commandStatus = `命令 ${shortId(commandId)} 已发送`;
    },

    sendTerminalInput(data: Uint8Array): void {
      if (!this.selectedSessionInteractive) return;
      this.sendCommand('terminal.input', {
        encoding: 'base64',
        data: encodeBase64(data),
      });
    },

    resizeTerminal(columns: number, rows: number): void {
      if (!this.selectedSessionInteractive) return;
      this.sendCommand('terminal.resize', { columns, rows });
    },

    interruptSession(): void {
      this.sendCommand('session.interrupt', {});
    },

    stopSession(): void {
      this.sendCommand('session.stop', {});
    },

    startToolTurn(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      this.sendCommand('tool.turn.start', { text: trimmed });
    },

    interruptToolTurn(): void {
      this.sendCommand('tool.turn.interrupt', {});
    },

    resolveApproval(approvalId: string, turnId: string, decision: 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel'): void {
      this.sendCommand('tool.approval.resolve', { approvalId, turnId, decision });
    },

    resolveApprovalFromInbox(sessionId: string, approvalId: string, turnId: string, decision: 'allowOnce' | 'allowSession' | 'allowPolicy' | 'deny' | 'cancel'): void {
      this.sendCommandForSession(sessionId, 'tool.approval.resolve', { approvalId, turnId, decision });
    },

    async loadNotificationSettings(): Promise<void> {
      const response = await fetch('/api/notifications/settings');
      if (response.ok) this.notificationSettings = await response.json() as NotificationSettings;
    },

    async setApprovalNotifications(enabled: boolean): Promise<void> {
      const response = await fetch('/api/notifications/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) { this.error = await responseError(response, '通知设置失败'); return; }
      this.notificationSettings = await response.json() as NotificationSettings;
    },

    resolveUserInput(requestId: string, turnId: string, answers: Record<string, string[]>): void {
      this.sendCommand('tool.user-input.resolve', { requestId, turnId, answers });
    },

    handleSocketMessage(message: MessageEvent): void {
      try {
        const wire = JSON.parse(String(message.data)) as {
          event?: string;
          data?: WireEnvelope;
        };
        const envelope = wire.data;
        if (!envelope || envelope.protocolVersion !== '2') return;
        if (envelope.type === 'protocol.error') {
          const payload = envelope.payload as { message?: string };
          this.error = payload.message ?? '实时订阅被 Server 拒绝。';
          this.commandStatus = '命令执行失败';
          return;
        }
        if (envelope.type === 'command.ack') {
          const payload = envelope.payload as unknown as CommandAckPayload;
          this.commandStatus = `命令 ${shortId(payload.commandId)}：${payload.status}`;
          if (payload.status === 'failed' || payload.status === 'rejected') {
            this.error = payload.message ?? `命令执行失败 (${payload.errorCode ?? payload.status})`;
          }
          return;
        }
        if (envelope.type === 'session.subscribed') {
          const payload = envelope.payload as unknown as SessionSubscribedPayload;
          this.replaceSession(payload.session);
          this.eventsBySession[payload.session.id] = mergeEvents(
            this.eventsBySession[payload.session.id] ?? [],
            payload.events.slice(-MAX_HISTORY_EVENTS),
          ).slice(-MAX_HISTORY_EVENTS);
          this.lastSeqBySession[payload.session.id] = payload.latestSeq;
          this.scheduleCachePersist(payload.session.id);
          if (payload.session.id === this.selectedSessionId) {
            this.scrollToLatestRevision += 1;
          }
          return;
        }
        if (envelope.type === 'session.updated') {
          const payload = envelope.payload as unknown as SessionUpdatedPayload;
          this.replaceSession(payload.session);
          return;
        }
        if (
          (envelope.type === 'terminal.output' || envelope.type === 'tool.event') &&
          envelope.sessionId &&
          envelope.seq !== undefined
        ) {
          this.queueRealtimeEvent(envelope.sessionId, {
            seq: envelope.seq,
            type: envelope.type,
            payload: envelope.payload,
            createdAt: envelope.sentAt,
          });
        }
      } catch (error: unknown) {
        this.error = `无法解析实时消息：${describeError(error)}`;
      }
    },

    queueRealtimeEvent(sessionId: string, event: SessionEventRecord): void {
      let pending = pendingRealtimeEvents.get(sessionId);
      if (!pending) {
        pending = new Map();
        pendingRealtimeEvents.set(sessionId, pending);
      }
      pending.set(event.seq, event);
      if (realtimeFlushFrame !== undefined) return;
      realtimeFlushFrame = window.requestAnimationFrame(() => {
        realtimeFlushFrame = undefined;
        this.flushRealtimeEvents();
      });
    },

    flushRealtimeEvents(): void {
      if (realtimeFlushFrame !== undefined) {
        window.cancelAnimationFrame(realtimeFlushFrame);
        realtimeFlushFrame = undefined;
      }
      for (const [sessionId, pending] of pendingRealtimeEvents) {
        const incoming = [...pending.values()].sort((left, right) => left.seq - right.seq);
        if (!incoming.length) continue;
        this.eventsBySession[sessionId] = mergeEvents(
          this.eventsBySession[sessionId] ?? [],
          incoming,
        ).slice(-MAX_HISTORY_EVENTS);
        if (this.eventsBySession[sessionId]!.length >= MAX_HISTORY_EVENTS) {
          this.hasOlderBySession[sessionId] = true;
        }
        const latestSeq = incoming.at(-1)!.seq;
        this.lastSeqBySession[sessionId] = Math.max(
          this.lastSeqBySession[sessionId] ?? -1,
          latestSeq,
        );
        const session = this.sessions.find((item) => item.id === sessionId);
        if (session && latestSeq > session.stateVersion) session.stateVersion = latestSeq;
        this.scheduleCachePersist(sessionId);
      }
      pendingRealtimeEvents.clear();
    },

    scheduleCachePersist(sessionId: string): void {
      dirtyCacheSessions.add(sessionId);
      if (cacheWriteTimer !== undefined) return;
      cacheWriteTimer = window.setTimeout(() => {
        cacheWriteTimer = undefined;
        void this.persistDirtyCaches();
      }, CACHE_WRITE_DELAY_MS);
    },

    async persistDirtyCaches(): Promise<void> {
      if (cacheWriteTimer !== undefined) {
        window.clearTimeout(cacheWriteTimer);
        cacheWriteTimer = undefined;
      }
      const sessionIds = [...dirtyCacheSessions];
      dirtyCacheSessions.clear();
      await Promise.all(sessionIds.map(async (sessionId) => {
        const events = this.eventsBySession[sessionId];
        if (!events) return;
        const cachedEvents = events.slice(-MAX_CACHED_EVENTS);
        const lastSeq = Math.max(
          cachedEvents.at(-1)?.seq ?? -1,
          this.lastSeqBySession[sessionId] ?? -1,
        );
        const session = this.sessions.find((item) => item.id === sessionId);
        await saveSessionCache(sessionId, session, cachedEvents, lastSeq).catch(() => undefined);
      }));
    },

    replaceSession(session: SessionRecord): void {
      const index = this.sessions.findIndex((item) => item.id === session.id);
      if (index === -1) this.sessions.unshift(session);
      else this.sessions[index] = session;
    },

    touchHistory(sessionId: string): void {
      this.historyAccessOrder = [
        ...this.historyAccessOrder.filter((id) => id !== sessionId),
        sessionId,
      ];
    },

    evictInactiveHistories(): void {
      while (this.historyAccessOrder.length > MAX_MEMORY_SESSIONS) {
        const sessionId = this.historyAccessOrder.shift();
        if (!sessionId || sessionId === this.selectedSessionId) continue;
        delete this.eventsBySession[sessionId];
        delete this.hasOlderBySession[sessionId];
        dirtyCacheSessions.delete(sessionId);
      }
    },

    scheduleReconnect(): void {
      if (this.stopped || this.reconnectTimer !== undefined) return;
      const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt);
      this.reconnectAttempt += 1;
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, delay);
    },

    scheduleRefresh(): void {
      if (this.stopped || this.refreshTimer !== undefined) return;
      this.refreshTimer = window.setTimeout(async () => {
        this.refreshTimer = undefined;
        await this.refreshSessions();
        this.scheduleRefresh();
      }, SESSION_REFRESH_INTERVAL_MS);
    },

    isSessionInteractive(session: SessionRecord): boolean {
      if (!['starting', 'running'].includes(session.status)) return false;
      return this.devices.some(
        (device) => device.id === session.deviceId && device.status === 'connected',
      );
    },

    sessionDisplayStatus(session: SessionRecord): string {
      if (
        ['starting', 'running', 'stopping'].includes(session.status) &&
        !this.isSessionInteractive(session)
      ) {
        return 'offline';
      }
      return session.status;
    },

    sessionDisplayName(session: SessionRecord): string {
      return session.displayName?.trim() || session.toolKey;
    },
  },
});

async function loadHistory(sessionId: string): Promise<SessionEventRecord[]> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${INITIAL_HISTORY_EVENTS}`,
  );
  if (!response.ok) throw new Error(`历史事件请求失败 (${response.status})`);
  return (await response.json()) as SessionEventRecord[];
}

function mergeEvents(
  current: SessionEventRecord[],
  incoming: SessionEventRecord[],
): SessionEventRecord[] {
  if (!current.length) return deduplicateSorted(incoming);
  if (!incoming.length) return current;
  if (current.at(-1)!.seq < incoming[0]!.seq) return [...current, ...deduplicateSorted(incoming)];

  const merged: SessionEventRecord[] = [];
  let currentIndex = 0;
  let incomingIndex = 0;
  while (currentIndex < current.length || incomingIndex < incoming.length) {
    const currentEvent = current[currentIndex];
    const incomingEvent = incoming[incomingIndex];
    if (!incomingEvent || (currentEvent && currentEvent.seq < incomingEvent.seq)) {
      merged.push(currentEvent!);
      currentIndex += 1;
    } else if (!currentEvent || incomingEvent.seq < currentEvent.seq) {
      merged.push(incomingEvent);
      incomingIndex += 1;
    } else {
      merged.push(currentEvent);
      currentIndex += 1;
      incomingIndex += 1;
    }
  }
  return merged;
}

function deduplicateSorted(events: SessionEventRecord[]): SessionEventRecord[] {
  if (events.length < 2) return events;
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  return sorted.filter((event, index) => index === 0 || event.seq !== sorted[index - 1]!.seq);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join('；');
    if (body.message) return body.message;
  } catch {
    // The fallback includes the HTTP status when the response is not JSON.
  }
  return `${fallback} (${response.status})`;
}

function encodeBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function createUuid(): string {
  if (typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
