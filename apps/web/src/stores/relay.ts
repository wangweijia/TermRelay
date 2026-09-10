import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type {
  CommandAckPayload,
  SessionEventRecord,
  SessionRecord,
  SessionSubscribedPayload,
  WireEnvelope,
} from '../types';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const HISTORY_PAGE_SIZE = 1_000;
const MAX_HISTORY_EVENTS = 10_000;

export const useRelayStore = defineStore('relay', {
  state: () => ({
    sessions: [] as SessionRecord[],
    selectedSessionId: undefined as string | undefined,
    eventsBySession: {} as Record<string, SessionEventRecord[]>,
    lastSeqBySession: {} as Record<string, number>,
    connectionState: 'disconnected' as ConnectionState,
    loadingSessions: false,
    loadingHistory: false,
    error: undefined as string | undefined,
    socket: undefined as WebSocket | undefined,
    reconnectTimer: undefined as number | undefined,
    reconnectAttempt: 0,
    selectionVersion: 0,
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
  },

  actions: {
    async initialize(): Promise<void> {
      this.stopped = false;
      await this.refreshSessions();
      if (!this.selectedSessionId && this.sessions[0]) {
        await this.selectSession(this.sessions[0].id);
      }
      this.connect();
    },

    stop(): void {
      this.stopped = true;
      if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.socket?.close(1000, 'page closed');
      this.socket = undefined;
      this.connectionState = 'disconnected';
    },

    async refreshSessions(): Promise<void> {
      this.loadingSessions = true;
      try {
        const response = await fetch('/api/sessions');
        if (!response.ok) throw new Error(`会话列表请求失败 (${response.status})`);
        this.sessions = (await response.json()) as SessionRecord[];
        if (
          this.selectedSessionId &&
          !this.sessions.some((item) => item.id === this.selectedSessionId)
        ) {
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
      if (sessionId === this.selectedSessionId && this.eventsBySession[sessionId]) {
        this.subscribeSelected();
        return;
      }
      const previous = this.selectedSession;
      if (previous) this.sendSubscription('session.unsubscribe', previous, {});

      this.selectedSessionId = sessionId;
      const version = ++this.selectionVersion;
      this.loadingHistory = true;
      try {
        const history = await loadHistory(sessionId);
        if (version !== this.selectionVersion) return;
        this.eventsBySession[sessionId] = mergeEvents([], history);
        this.lastSeqBySession[sessionId] = history.at(-1)?.seq ?? -1;
        this.error = undefined;
        this.subscribeSelected();
      } catch (error: unknown) {
        if (version === this.selectionVersion) this.error = describeError(error);
      } finally {
        if (version === this.selectionVersion) this.loadingHistory = false;
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
        protocolVersion: '1',
        messageId: crypto.randomUUID(),
        deviceId: session.deviceId,
        sessionId: session.id,
        sentAt: new Date().toISOString(),
        payload,
      };
      this.socket.send(JSON.stringify({ event: 'message', data: envelope }));
    },

    sendCommand(
      type: 'terminal.input' | 'terminal.resize' | 'session.interrupt' | 'session.stop',
      payload: Record<string, unknown>,
    ): void {
      const session = this.selectedSession;
      if (!session || this.socket?.readyState !== WebSocket.OPEN) {
        this.error = 'Mac 命令无法发送：实时连接尚未建立。';
        return;
      }
      const commandId = crypto.randomUUID();
      const envelope: WireEnvelope = {
        type,
        protocolVersion: '1',
        messageId: crypto.randomUUID(),
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
      this.sendCommand('terminal.input', {
        encoding: 'base64',
        data: encodeBase64(data),
      });
    },

    resizeTerminal(columns: number, rows: number): void {
      this.sendCommand('terminal.resize', { columns, rows });
    },

    interruptSession(): void {
      this.sendCommand('session.interrupt', {});
    },

    stopSession(): void {
      this.sendCommand('session.stop', {});
    },

    handleSocketMessage(message: MessageEvent): void {
      try {
        const wire = JSON.parse(String(message.data)) as {
          event?: string;
          data?: WireEnvelope;
        };
        const envelope = wire.data;
        if (!envelope || envelope.protocolVersion !== '1') return;
        if (envelope.type === 'protocol.error') {
          const payload = envelope.payload as { message?: string };
          this.error = payload.message ?? '实时订阅被 Server 拒绝。';
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
            payload.events,
          );
          this.lastSeqBySession[payload.session.id] = payload.latestSeq;
          return;
        }
        if (
          envelope.type === 'terminal.output' &&
          envelope.sessionId &&
          envelope.seq !== undefined
        ) {
          this.eventsBySession[envelope.sessionId] = mergeEvents(
            this.eventsBySession[envelope.sessionId] ?? [],
            [
              {
                seq: envelope.seq,
                type: envelope.type,
                payload: envelope.payload,
                createdAt: envelope.sentAt,
              },
            ],
          );
          this.lastSeqBySession[envelope.sessionId] = Math.max(
            this.lastSeqBySession[envelope.sessionId] ?? -1,
            envelope.seq,
          );
          const session = this.sessions.find(
            (item) => item.id === envelope.sessionId,
          );
          if (session && envelope.seq > session.stateVersion) {
            session.stateVersion = envelope.seq;
          }
        }
      } catch (error: unknown) {
        this.error = `无法解析实时消息：${describeError(error)}`;
      }
    },

    replaceSession(session: SessionRecord): void {
      const index = this.sessions.findIndex((item) => item.id === session.id);
      if (index === -1) this.sessions.unshift(session);
      else this.sessions[index] = session;
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
  },
});

async function loadHistory(sessionId: string): Promise<SessionEventRecord[]> {
  const events: SessionEventRecord[] = [];
  let afterSeq = -1;
  while (events.length < MAX_HISTORY_EVENTS) {
    const remaining = MAX_HISTORY_EVENTS - events.length;
    const limit = Math.min(HISTORY_PAGE_SIZE, remaining);
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}&limit=${limit}`,
    );
    if (!response.ok) throw new Error(`历史事件请求失败 (${response.status})`);
    const page = (await response.json()) as SessionEventRecord[];
    events.push(...page);
    if (page.length < limit) return events;
    afterSeq = page.at(-1)!.seq;
  }
  return events;
}

function mergeEvents(
  current: SessionEventRecord[],
  incoming: SessionEventRecord[],
): SessionEventRecord[] {
  const events = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) {
    if (!events.has(event.seq)) events.set(event.seq, event);
  }
  return [...events.values()].sort((left, right) => left.seq - right.seq);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}
