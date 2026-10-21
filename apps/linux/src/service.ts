import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { ToolEventPayload } from '@termrelay/contracts';
import { ConfigStore, readCredential, writePrivateJSON } from './config.js';
import { CodexRuntime, type AgentRuntime } from './codex.js';
import { Protocol, BufferLimitError, type Command, type Packet } from './protocol.js';
import { TerminalRuntime, type PtyEvent } from './pty.js';
import { RelayConnection, type Connection, type RelayEvent } from './transport.js';
import { UnknownResultError } from './rpc.js';
import { errorMessage, findExecutable } from './util.js';

export interface ServiceOptions {
  connection?: (url: string, credential: string, event: (event: RelayEvent) => void) => Connection;
  codex?: (executable: string, cwd: string, emit: (event: ToolEventPayload) => void) => AgentRuntime;
  log?: (message: string) => void;
}

export class AgentService {
  readonly config;
  readonly protocol: Protocol;
  readonly terminals = new Map<string, TerminalRuntime>();
  readonly agents = new Map<string, AgentRuntime>();
  private readonly tasks = new Set<Promise<void>>();
  private connection?: Connection;
  private timer?: NodeJS.Timeout;
  private heartbeatAt = 0;
  private heartbeatInterval = 15000;
  private stopping = false;
  private finish?: () => void;
  private lastError?: string;
  private failed = false;
  state = 'starting';
  private readonly log: (message: string) => void;
  constructor(readonly store: ConfigStore, private readonly options: ServiceOptions = {}) {
    this.config = store.load();
    this.log = options.log ?? (message => console.error(message));
    this.protocol = new Protocol(this.config.deviceId, this.config.name,
      packet => this.send(packet), command => this.schedule(command),
      (id, enabled) => {
        const agent = this.agents.get(id);
        if (agent) this.track(agent.setAutoApprove(enabled).catch(async error => {
          this.log(`Automatic approval failed: ${errorMessage(error)}`);
          await this.stopSession(id, true);
        }));
      });
  }
  private send(packet: Packet): void {
    if (!this.connection) throw new Error('Relay is not initialized');
    this.connection.send(packet);
  }
  private status(): void {
    writePrivateJSON(this.store.statusPath, {
      pid: process.pid, deviceId: this.config.deviceId, serverURL: this.config.serverURL,
      state: this.state, updatedAt: new Date().toISOString(), lastError: this.lastError ?? null,
      sessions: [...this.protocol.sessions].map(([id, session]) => ({
        id, toolKey: session.started.toolKey, runtimeMode: session.started.runtimeMode,
        workspaceId: session.started.workspaceId, ended: !!session.ended, unacknowledgedBytes: session.bytes,
      })),
    });
  }
  private fail(error: unknown): void {
    this.failed = true; this.lastError = errorMessage(error); this.log(this.lastError);
    this.stop();
  }
  stop(): void {
    this.stopping = true; this.state = 'stopping'; this.finish?.();
  }
  private guard(action: () => void): void {
    if (this.stopping) return;
    try { action(); } catch (error) { this.fail(error); }
  }
  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.catch(error => this.fail(error)).finally(() => this.tasks.delete(task));
  }
  private schedule(command: Command): void {
    if (this.tasks.size >= 32) throw new Error('Agent command queue is full');
    this.track(Promise.resolve().then(async () => {
      try {
        if (command.kind === 'session.stop') await this.stopSession(command.sessionId);
        else if (this.agents.has(command.sessionId)) await this.agents.get(command.sessionId)!.command(command.kind, command.payload, command.commandId);
        else {
          const terminal = this.terminals.get(command.sessionId);
          if (!terminal) throw new Error('Session runtime unavailable');
          await terminal.command(command.kind, command.payload);
        }
      } catch (error) {
        this.log(`Command ${command.kind} failed: ${errorMessage(error)}`);
        this.protocol.complete(command, error);
        if (error instanceof UnknownResultError) await this.stopSession(command.sessionId, true);
        return;
      }
      this.protocol.complete(command);
    }));
  }
  private async stopSession(id: string, failed = false): Promise<void> {
    try {
      await (this.agents.get(id) ?? this.terminals.get(id))?.close();
    } catch (error) {
      this.protocol.end(id, true); throw error;
    }
    this.protocol.end(id, failed);
    this.status();
  }
  private onTool(id: string, event: ToolEventPayload): void {
    this.guard(() => {
      if (!this.protocol.sessions.has(id)) throw new Error('Provider emitted events before session readiness');
      if (this.protocol.sessions.get(id)?.ended) return;
      try { this.protocol.append(id, event); }
      catch (error) {
        if (!(error instanceof BufferLimitError)) throw error;
        this.log(error.message); this.track(this.stopSession(id, true)); return;
      }
      if (event.kind === 'error') {
        this.log(`Agent error: ${String(event.data.message)}`);
        this.track(this.stopSession(id, true));
      }
    });
  }
  private onPty(id: string, event: PtyEvent): void {
    this.guard(() => {
      const session = this.protocol.sessions.get(id);
      if (!session || session.ended) return;
      if (event.kind === 'output') {
        try { this.protocol.append(id, event.data); }
        catch (error) {
          if (!(error instanceof BufferLimitError)) throw error;
          this.log(error.message); this.track(this.stopSession(id, true));
        }
      } else if (event.kind === 'exit') {
        const failed = event.code !== 0 && !this.terminals.get(id)?.stopping;
        this.protocol.end(id, failed);
        if (failed) this.log(`PTY exited with status ${event.code}`);
        this.status();
      } else {
        this.log(event.error.message); this.track(this.stopSession(id, true));
      }
    });
  }
  private onRelay(event: RelayEvent): void {
    this.guard(() => {
      switch (event.kind) {
        case 'connected': this.state = 'registering'; this.protocol.connected(); break;
        case 'disconnected':
          this.protocol.registered = false; this.state = 'reconnecting'; this.log(event.reason); break;
        case 'fatal': throw event.error;
        case 'message': {
          const interval = this.protocol.receive(event.packet);
          if (interval !== undefined) {
            this.heartbeatInterval = interval; this.state = 'online'; this.lastError = undefined;
            this.protocol.heartbeat(); this.heartbeatAt = Date.now();
          }
          break;
        }
      }
      this.status();
    });
  }
  private async startSessions(): Promise<void> {
    for (const workspace of this.config.workspaces) {
      if (realpathSync(workspace.path) !== workspace.path || !statSync(workspace.path).isDirectory()) throw new Error(`Workspace authorization changed: ${workspace.name}`);
      this.protocol.addWorkspace(workspace.id, workspace.name);
    }
    const tools = new Set<string>();
    for (const profile of this.config.sessions) {
      const workspace = this.config.workspaces.find(w => w.id === profile.workspaceId)!;
      const id = randomUUID();
      if (profile.provider === 'shell') {
        this.protocol.start(id, workspace.id, 'shell', 'pty');
        this.terminals.set(id, new TerminalRuntime(workspace.path, event => this.onPty(id, event)));
      } else {
        const executable = this.config.tools.codex ?? findExecutable('codex');
        if (!executable) throw new Error('Codex is not installed; configure tool codex /absolute/path');
        const factory = this.options.codex ?? ((path, cwd, emit) => new CodexRuntime(path, cwd, emit));
        const agent = factory(executable, workspace.path, event => this.onTool(id, event));
        this.agents.set(id, agent);
        await agent.start();
        if (this.stopping) throw new Error('Agent startup failed');
        this.protocol.start(id, workspace.id, 'codex', 'acp'); agent.publishConfiguration();
      }
      tools.add(profile.provider); this.log(`Session ready: ${id} (${profile.provider})`);
    }
    this.protocol.tools = [...tools];
    if (!tools.size) this.log('No startup sessions configured; remote creation is not yet implemented');
  }
  async run(): Promise<number> {
    const stopped = new Promise<void>(resolve => { this.finish = resolve; });
    const onSignal = (): void => this.stop();
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    try {
      this.status();
      const factory = this.options.connection ?? ((url, token, event) => new RelayConnection(url, token, event));
      this.connection = factory(this.config.serverURL, readCredential(this.config), event => this.onRelay(event));
      await this.startSessions();
      if (!this.stopping) {
        this.state = 'connecting'; this.connection.start(); this.status();
        this.timer = setInterval(() => this.guard(() => {
          this.protocol.flush();
          if (Date.now() - this.heartbeatAt >= this.heartbeatInterval) { this.protocol.heartbeat(); this.heartbeatAt = Date.now(); }
        }), 50);
      }
      if (!this.stopping) await stopped;
    } catch (error) { this.fail(error); }
    finally {
      this.stopping = true;
      clearInterval(this.timer);
      this.connection?.close(); this.protocol.registered = false;
      const results = await Promise.allSettled([...this.agents.values(), ...this.terminals.values()].map(runtime => runtime.close()));
      for (const result of results) if (result.status === 'rejected') this.fail(result.reason);
      const tasks = await Promise.allSettled([...this.tasks]);
      for (const result of tasks) if (result.status === 'rejected') this.fail(result.reason);
      for (const id of this.protocol.sessions.keys()) this.protocol.end(id, this.failed);
      if (this.protocol.unacknowledgedBytes) this.log(`${this.protocol.unacknowledgedBytes} unacknowledged bytes are memory-only and will not survive restart`);
      this.state = this.failed ? 'failed' : 'stopped';
      try { this.status(); } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
    }
    return this.failed ? 1 : 0;
  }
}
