import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { ToolEventPayload } from '@termrelay/contracts';
import { ConfigStore, readCredential, writePrivateJSON } from './config.js';
import { CodexRuntime, type AgentRuntime } from './codex.js';
import { Protocol, BufferLimitError, type Command, type Packet } from './protocol.js';
import { TerminalRuntime, type PtyEvent } from './pty.js';
import { RelayConnection, type Connection, type RelayEvent } from './transport.js';
import { UnknownResultError } from './rpc.js';
import { errorMessage, executable, findExecutable, integer, text } from './util.js';

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
  private readonly startingSessions = new Set<string>();
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
        if (command.kind === 'session.start') await this.startRemoteSession(command);
        else if (command.kind === 'session.stop') await this.stopSession(command.sessionId);
        else if (this.agents.has(command.sessionId)) await this.agents.get(command.sessionId)!.command(command.kind, command.payload, command.commandId);
        else {
          const terminal = this.terminals.get(command.sessionId);
          if (!terminal) throw new Error('Session runtime unavailable');
          await terminal.command(command.kind, command.payload);
        }
      } catch (error) {
        this.log(`Command ${command.kind} failed: ${errorMessage(error)}`);
        this.protocol.complete(command, command.kind === 'session.start'
          ? new Error('Session startup failed; check the local Agent log and workspace/tool authorization') : error);
        if (error instanceof UnknownResultError && this.protocol.sessions.has(command.sessionId)) await this.stopSession(command.sessionId, true);
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
    const codex = this.config.tools.codex ?? findExecutable('codex');
    this.protocol.tools = [
      ...(findExecutable(process.env.SHELL || '/bin/bash') ? ['shell'] : []),
      ...(codex && executable(codex) ? ['codex'] : []),
    ];
    for (const workspace of this.config.workspaces) {
      if (realpathSync(workspace.path) !== workspace.path || !statSync(workspace.path).isDirectory()) throw new Error(`Workspace authorization changed: ${workspace.name}`);
      this.protocol.addWorkspace(workspace.id, workspace.name, workspace.remoteStartAllowed
        ? this.protocol.tools.map(toolKey => ({ toolKey, runtimeMode: toolKey === 'shell' ? 'pty' : 'acp' })) : []);
    }
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
      this.log(`Session ready: ${id} (${profile.provider})`);
    }
    if (!this.config.sessions.length) this.log('No startup sessions configured; waiting for authorized remote creation');
  }

  private async startRemoteSession(command: Command): Promise<void> {
    if (this.stopping) throw new Error('Agent is stopping');
    const active = [...this.protocol.sessions.values()].filter(s => !s.ended).length;
    if (active + this.startingSessions.size >= 8) throw new Error('Maximum eight active or starting sessions');
    this.startingSessions.add(command.sessionId);
    try {
      // Re-read authorization at execution time; a stale Server catalog cannot grant access.
      const config = this.store.load();
      const workspace = config.workspaces.find(w => w.id === command.payload.workspaceId);
      if (!workspace?.remoteStartAllowed || realpathSync(workspace.path) !== workspace.path || !statSync(workspace.path).isDirectory()) throw new Error('Workspace authorization is unavailable or changed');
      const id = command.sessionId;
      const displayName = command.payload.displayName === undefined ? undefined : text(command.payload.displayName, 128);
      if (command.payload.toolKey === 'shell' && command.payload.runtimeMode === 'pty') {
        const pending: PtyEvent[] = [];
        let published = false, startupBytes = 0;
        let startupError: Error | undefined;
        const terminal = new TerminalRuntime(workspace.path, event => {
          if (published) { this.onPty(id, event); return; }
          if (event.kind === 'output') {
            startupBytes += event.data.length;
            if (startupBytes > 1024 * 1024) startupError = new Error('PTY startup output exceeded 1 MiB');
            else pending.push(event);
          } else startupError = event.kind === 'error' ? event.error : new Error(`PTY exited during startup (${event.code})`);
        });
        this.terminals.set(id, terminal);
        try {
          await terminal.ready;
          await terminal.command('terminal.resize', { rows: integer(command.payload.rows, 1, 1000), columns: integer(command.payload.columns, 1, 1000) });
          if (startupError) throw startupError;
          if (this.stopping) throw new Error('Agent is stopping');
          this.protocol.start(id, workspace.id, 'shell', 'pty', displayName);
          published = true;
          for (const event of pending) this.onPty(id, event);
        } catch (error) {
          if (this.protocol.sessions.has(id)) this.protocol.end(id, true);
          await terminal.close(); this.terminals.delete(id); throw error;
        }
      } else if (command.payload.toolKey === 'codex' && command.payload.runtimeMode === 'acp') {
        const executable = config.tools.codex ?? findExecutable('codex');
        if (!executable) throw new Error('Codex is not available');
        const pending: ToolEventPayload[] = [];
        let published = false, startupBytes = 0;
        let startupError: Error | undefined;
        const agent = (this.options.codex ?? ((path, cwd, emit) => new CodexRuntime(path, cwd, emit)))(
          executable, workspace.path, event => {
            if (published) { this.onTool(id, event); return; }
            startupBytes += Buffer.byteLength(JSON.stringify(event));
            if (event.kind === 'error') startupError = new Error(String(event.data.message));
            else if (startupBytes > 1024 * 1024) startupError = new Error('Provider startup events exceeded 1 MiB');
            else pending.push(event);
          });
        this.agents.set(id, agent);
        try {
          await agent.start();
          if (startupError) throw startupError;
          if (this.stopping) throw new Error('Agent is stopping');
          this.protocol.start(id, workspace.id, 'codex', 'acp', displayName);
          published = true;
          for (const event of pending) this.onTool(id, event);
          agent.publishConfiguration();
        } catch (error) {
          if (this.protocol.sessions.has(id)) this.protocol.end(id, true);
          await agent.close(); this.agents.delete(id); throw error;
        }
      } else throw new Error('Unsupported tool/runtime mode');
      this.status();
    } finally { this.startingSessions.delete(command.sessionId); }
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
