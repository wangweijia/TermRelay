import { randomUUID } from 'node:crypto';
import type { Envelope, SessionStartedPayload, SessionEndedPayload, ToolEventPayload, WorkspaceRegisteredPayload, CommandAckPayload } from '@termrelay/contracts';
import { VERSION, MAX_MESSAGE, errorMessage, integer, record, text, type JsonObject } from './util.js';
import { validateCommand, validateEnvelope, validateToolEvent } from './validation.js';

export const MAX_BUFFER = 16 * 1024 * 1024;
export interface Packet { event: 'message'; data: Envelope<unknown> }
export interface Command { sessionId: string; commandId: string; kind: string; payload: JsonObject }
export class BufferLimitError extends Error {}
const bytes = (value: Buffer | ToolEventPayload): number => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(JSON.stringify(value));

export class SessionJournal {
  readonly pending = new Map<number, Buffer | ToolEventPayload>();
  nextSeq = 1; bytes = 0; acknowledged = 0; sent = 0; ready = false; endSent = false;
  ended?: SessionEndedPayload;
  constructor(readonly started: SessionStartedPayload) {}
  acknowledge(value: unknown): void {
    const seq = integer(value, 0, this.nextSeq - 1);
    if (seq < this.acknowledged) throw new Error('Server watermark regressed; acknowledged history cannot be recovered');
    for (const [key, value] of this.pending) {
      if (key > seq) break;
      this.bytes -= bytes(value); this.pending.delete(key);
    }
    this.acknowledged = this.sent = seq; this.ready = true;
  }
}

export class Protocol {
  registered = false;
  tools: string[] = [];
  readonly workspaces = new Map<string, WorkspaceRegisteredPayload>();
  readonly sessions = new Map<string, SessionJournal>();
  readonly commands = new Map<string, { sessionId: string; result: CommandAckPayload }>();
  constructor(
    readonly deviceId: string, readonly name: string,
    private readonly send: (packet: Packet) => void,
    private readonly command: (command: Command) => void,
    private readonly autoApprove: (sessionId: string, enabled: boolean) => void = () => undefined,
  ) {}
  publish(type: string, payload: unknown, sessionId?: string, context: Partial<Pick<Envelope, 'seq' | 'commandId'>> = {}): void {
    const packet: Packet = { event: 'message', data: {
      type, payload, protocolVersion: '2', messageId: randomUUID(), deviceId: this.deviceId,
      sentAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}), ...context,
    } };
    if (Buffer.byteLength(JSON.stringify(packet)) > MAX_MESSAGE) throw new Error('Relay message exceeds 1 MiB');
    this.send(packet);
  }
  connected(): void {
    this.registered = false;
    for (const session of this.sessions.values()) { session.ready = false; session.endSent = false; }
    this.publish('device.register', { name: this.name, appVersion: VERSION, platform: 'linux', tools: this.tools });
  }
  addWorkspace(id: string, name: string): void {
    const value = { workspaceId: id, displayName: name, available: true, remoteStartAllowed: false };
    this.workspaces.set(id, value);
    if (this.registered) this.publish('workspace.registered', value);
  }
  start(id: string, workspaceId: string, toolKey: string, runtimeMode: 'pty' | 'acp'): void {
    if (this.sessions.has(id)) throw new Error('Session ID already exists');
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error('Unknown workspace');
    const journal = new SessionJournal({ workspaceId, toolKey, runtimeMode, displayName: workspace.displayName, startedAt: new Date().toISOString() });
    this.sessions.set(id, journal);
    if (this.registered) this.publish('session.started', journal.started, id, { seq: 0 });
  }
  append(id: string, value: Buffer | ToolEventPayload): void {
    const session = this.sessions.get(id);
    if (!session || session.ended) throw new Error('Session is closed');
    if (Buffer.isBuffer(value) !== (session.started.runtimeMode === 'pty')) throw new Error('PTY and ACP events cannot be mixed');
    if (!Buffer.isBuffer(value)) validateToolEvent(value);
    if (this.unacknowledgedBytes + bytes(value) > MAX_BUFFER) throw new BufferLimitError('Unacknowledged events exceeded 16 MiB; stopping session');
    const copy = Buffer.isBuffer(value) ? Buffer.from(value) : structuredClone(value);
    session.pending.set(session.nextSeq++, copy); session.bytes += bytes(copy);
  }
  get unacknowledgedBytes(): number { return [...this.sessions.values()].reduce((total, session) => total + session.bytes, 0); }
  end(id: string, failed = false): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown session');
    session.ended ??= { status: failed ? 'failed' : 'finished', finishedAt: new Date().toISOString() };
  }
  heartbeat(): void {
    if (this.registered) this.publish('device.heartbeat', { connectionState: 'connected', activeSessionCount: [...this.sessions.values()].filter(s => !s.ended).length });
  }
  flush(): void {
    if (!this.registered) return;
    for (const [id, session] of this.sessions) {
      if (!session.ready) continue;
      const batch = [...session.pending].filter(([seq]) => seq > session.sent).slice(0, 32);
      if (batch.length) {
        for (const [seq, value] of batch) {
          this.publish(Buffer.isBuffer(value) ? 'terminal.output' : 'tool.event',
            Buffer.isBuffer(value) ? { encoding: 'base64', data: value.toString('base64') } : value, id, { seq });
          session.sent = seq;
        }
        session.ready = false; this.publish('session.sync', {}, id);
      } else if (session.ended && !session.endSent) {
        this.publish('session.ended', session.ended, id); session.endSent = true;
      }
    }
  }
  receive(input: unknown): number | undefined {
    const packet = record(input);
    if (packet.event !== 'message') throw new Error('Invalid relay packet');
    const message = validateEnvelope(packet.data);
    if (message.deviceId !== this.deviceId) throw new Error('Server device identity mismatch');
    const kind = text(message.type), payload = record(message.payload);
    if (kind === 'protocol.error') throw new Error(`Server protocol error: ${text(payload.code)}`);
    if (kind === 'client.authorization.revoked') throw new Error('Device authorization revoked; pair again');
    if (kind === 'device.registered') {
      const interval = integer(payload.heartbeatIntervalMs, 1000, 300000);
      this.registered = true;
      for (const workspace of this.workspaces.values()) this.publish('workspace.registered', workspace);
      for (const [id, session] of this.sessions) this.publish('session.started', session.started, id, { seq: 0 });
      return interval;
    }
    if (!this.registered) throw new Error('Server sent command before registration');
    const sessionId = text(message.sessionId);
    if (kind === 'session.synced') {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error('Unknown session');
      session.acknowledge(payload.lastAcceptedSeq);
      if (payload.autoApproveEnabled !== undefined) {
        if (typeof payload.autoApproveEnabled !== 'boolean') throw new Error('Invalid automatic approval state');
        this.autoApprove(sessionId, payload.autoApproveEnabled);
      }
    } else {
      const commandId = text(message.commandId).toLowerCase();
      const existing = this.commands.get(commandId);
      if (existing) {
        if (existing.sessionId !== sessionId) throw new Error('Command ID reused across sessions');
        this.ack(sessionId, existing.result); return;
      }
      try {
        const session = this.sessions.get(sessionId);
        if (!session || session.ended) throw new Error('Session is closed or unavailable');
        if (kind !== 'session.stop' && kind.startsWith('tool.') !== (session.started.runtimeMode === 'acp')) throw new Error('Command does not match session runtime mode');
        validateCommand(kind, payload);
        this.command({ sessionId, commandId, kind, payload });
        this.remember(sessionId, { commandId, status: 'accepted' });
      } catch (error) {
        this.remember(sessionId, { commandId, status: 'rejected', errorCode: 'invalid_command', message: errorMessage(error).slice(0, 2048) });
      }
    }
  }
  complete(command: Command, error?: unknown): void {
    this.remember(command.sessionId, error
      ? { commandId: command.commandId, status: 'failed', errorCode: 'runtime_error', message: errorMessage(error).slice(0, 2048) }
      : { commandId: command.commandId, status: 'completed' });
  }
  private remember(sessionId: string, result: CommandAckPayload): void {
    this.commands.set(result.commandId, { sessionId, result });
    if (this.commands.size > 4096) this.commands.delete(this.commands.keys().next().value!);
    this.ack(sessionId, result);
  }
  private ack(sessionId: string, result: CommandAckPayload): void {
    if (this.registered) this.publish('command.ack', result, sessionId, { commandId: result.commandId });
  }
}
