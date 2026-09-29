import {
  ConflictException, GatewayTimeoutException, Injectable, NotFoundException, OnModuleDestroy,
  OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ShortcutCatalogPayload, ShortcutRunUpdatePayload, ShortcutRunStartPayload,
  ShortcutRunCancelPayload,
  ShortcutRunInputPayload, ShortcutRunInputAckPayload,
} from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import {
  ShortcutsRepository, UNKNOWN_EXECUTION_RESULT,
  type ShortcutRecord, type ShortcutRunRecord,
} from './shortcuts.repository';

const RUNNING_WRITE_INTERVAL_MS = 250;
const INPUT_ACK_TIMEOUT_MS = 10_000;
const INPUT_RESULT_LIMIT = 512;
const UNKNOWN_INPUT_DELIVERY = 'Device disconnected; shortcut input delivery is unknown. Check the run before trying again.';

interface InputRequest {
  runId: string;
  deviceId: string;
  answer: ShortcutRunInputPayload['answer'];
}

interface PendingInput extends InputRequest {
  socket: WebSocket;
  promise: Promise<{ accepted: true }>;
  settle: (error?: Error) => void;
  timer: NodeJS.Timeout;
}

interface CompletedInput extends InputRequest {
  socket: WebSocket;
  result: { accepted: true } | Error;
}

interface RunningWrites {
  deviceId: string;
  pending?: ShortcutRunUpdatePayload;
  timer?: NodeJS.Timeout;
  write: Promise<boolean>;
  lastWriteAt: number;
  terminal: boolean;
}

@Injectable()
export class ShortcutsService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;
  private readonly catalogWrites = new Map<string, Promise<void>>();
  private readonly runningWrites = new Map<string, RunningWrites>();
  private readonly pendingInputs = new Map<string, PendingInput>();
  private readonly completedInputs = new Map<string, CompletedInput>();

  constructor(
    private readonly store: ShortcutsRepository,
    private readonly registry: DeviceConnectionRegistry,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.registry.subscribe((device) => {
      if (device.presence === 'offline') {
        this.failInputs(device.deviceId);
        void this.store.failActive(device.deviceId, UNKNOWN_EXECUTION_RESULT);
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    for (const state of this.runningWrites.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.runningWrites.clear();
    for (const pending of this.pendingInputs.values()) {
      pending.settle(new ConflictException(UNKNOWN_INPUT_DELIVERY));
    }
    this.completedInputs.clear();
  }

  catalog(deviceId: string, payload: ShortcutCatalogPayload): Promise<boolean> {
    const prior = this.catalogWrites.get(deviceId) ?? Promise.resolve();
    const write = prior.then(() => this.store.replaceCatalog(deviceId, payload.shortcuts));
    const settled = write.then(() => undefined, () => undefined);
    this.catalogWrites.set(deviceId, settled);
    void settled.then(() => {
      if (this.catalogWrites.get(deviceId) === settled) this.catalogWrites.delete(deviceId);
    });
    return write;
  }

  async list(): Promise<ShortcutRecord[]> {
    return (await this.store.list()).map((entry) => ({
      id: entry.id, deviceId: entry.deviceId, revision: entry.revision,
      name: entry.name, description: entry.description, workspaceId: entry.workspaceId,
      proxyMode: entry.proxyMode, requiresConfirmation: entry.requiresConfirmation,
      online: this.connected(entry.deviceId) !== undefined,
    }));
  }

  getRun(id: string): Promise<ShortcutRunRecord | undefined> {
    return this.store.findRun(id);
  }

  listRuns(limit: number): Promise<ShortcutRunRecord[]> {
    return this.store.listRuns(limit);
  }

  async start(id: string, runId: string): Promise<ShortcutRunRecord> {
    const previous = await this.store.findRun(runId);
    if (previous) {
      if (previous.shortcutId !== id.toLowerCase()) throw new ConflictException('runId belongs to another shortcut');
      return previous;
    }
    const shortcut = await this.store.findShortcut(id);
    if (!shortcut) throw new NotFoundException('shortcut not found');
    const socket = this.connected(shortcut.deviceId);
    if (!socket) throw new ServiceUnavailableException('shortcut device is offline');
    const created = await this.store.createRun(runId, shortcut);
    if (created === 'busy') throw new ConflictException('shortcut already has an active run');
    if (created === 'duplicate') {
      const existing = await this.store.findRun(runId);
      if (!existing || existing.shortcutId !== id.toLowerCase()) {
        throw new ConflictException('runId belongs to another shortcut');
      }
      return existing;
    }
    const latest = await this.store.findShortcut(id);
    if (!latest || latest.deviceId !== shortcut.deviceId || latest.revision !== shortcut.revision
      || this.connected(shortcut.deviceId) !== socket) {
      await this.store.failRun(runId,
        this.connected(shortcut.deviceId) !== socket
          ? UNKNOWN_EXECUTION_RESULT : 'Shortcut changed before dispatch.');
      return (await this.store.findRun(runId))!;
    }
    try {
      this.send(socket, shortcut.deviceId, 'shortcut.run.start', {
        runId: runId.toLowerCase(), shortcutId: shortcut.id, revision: shortcut.revision,
      });
    } catch {
      await this.store.failRun(runId, UNKNOWN_EXECUTION_RESULT);
    }
    return (await this.store.findRun(runId))!;
  }

  async update(deviceId: string, payload: ShortcutRunUpdatePayload): Promise<boolean> {
    const id = payload.runId.toLowerCase();
    const state = this.runningWrites.get(id);
    if (state?.terminal || (state && state.deviceId !== deviceId)) return false;
    const run = await this.store.findRun(id);
    if (!run || run.deviceId !== deviceId || !['queued', 'running'].includes(run.status)) return false;
    if (payload.status !== 'running') {
      const current = this.runningWrites.get(id);
      if (current?.terminal) return false;
      try {
        if (current) {
          current.terminal = true;
          if (current.timer) clearTimeout(current.timer);
          current.timer = undefined;
          await current.write;
          if (current.pending) {
            const pending = current.pending;
            current.pending = undefined;
            await this.store.updateRun(deviceId, pending);
          }
        }
        return !!await this.store.updateRun(deviceId, payload);
      } finally {
        this.runningWrites.delete(id);
      }
    }
    const current = this.runningWrites.get(id);
    if (current?.terminal) return false;
    if (current) {
      current.pending = { ...current.pending, ...payload };
      this.scheduleRunningFlush(id, current);
      return true;
    }
    const first: RunningWrites = {
      deviceId, write: Promise.resolve(true), lastWriteAt: Date.now(), terminal: false,
    };
    this.runningWrites.set(id, first);
    first.write = this.store.updateRun(deviceId, payload).then((result) => !!result);
    try {
      return await first.write;
    } finally {
      if (!first.terminal) this.scheduleRunningFlush(id, first);
    }
  }

  private scheduleRunningFlush(id: string, state: RunningWrites): void {
    if (state.timer || state.terminal) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const pending = state.pending;
      if (!pending || state.terminal) {
        if (!state.terminal) this.runningWrites.delete(id);
        return;
      }
      state.pending = undefined;
      state.lastWriteAt = Date.now();
      state.write = state.write.then(() => this.store.updateRun(state.deviceId, pending).then(Boolean));
      void state.write.then(
        () => { if (!state.terminal) this.scheduleRunningFlush(id, state); },
        () => { this.runningWrites.delete(id); },
      );
    }, Math.max(0, RUNNING_WRITE_INTERVAL_MS - (Date.now() - state.lastWriteAt)));
  }

  async cancel(runId: string): Promise<ShortcutRunRecord> {
    const run = await this.store.findRun(runId);
    if (!run) throw new NotFoundException('shortcut run not found');
    if (!['queued', 'running'].includes(run.status)) return run;
    const socket = this.connected(run.deviceId);
    if (!socket) {
      await this.store.failRun(runId, UNKNOWN_EXECUTION_RESULT);
      return (await this.store.findRun(runId))!;
    }
    try {
      this.send(socket, run.deviceId, 'shortcut.run.cancel', { runId: run.id });
      await this.store.requestCancel(runId);
    } catch {
      await this.store.failRun(runId, UNKNOWN_EXECUTION_RESULT);
    }
    return (await this.store.findRun(runId))!;
  }

  async input(
    runId: string, commandId: string, answer: ShortcutRunInputPayload['answer'],
  ): Promise<{ accepted: true }> {
    runId = runId.toLowerCase();
    commandId = commandId.toLowerCase();
    const existing = this.inputResult(runId, commandId, answer);
    if (existing) return existing;
    const run = await this.store.findRun(runId);
    // Another request may have registered this ID during the database lookup.
    const concurrent = this.inputResult(runId, commandId, answer);
    if (concurrent) return concurrent;
    if (!run) throw new NotFoundException('shortcut run not found');
    if (run.status !== 'running') throw new ConflictException('shortcut run is not running');
    const socket = this.connected(run.deviceId);
    if (!socket) throw new ServiceUnavailableException('shortcut device is offline');

    let resolve!: (result: { accepted: true }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ accepted: true }>((yes, no) => { resolve = yes; reject = no; });
    const request: InputRequest = { runId, deviceId: run.deviceId, answer };
    const settle = (error?: Error) => {
      const pending = this.pendingInputs.get(commandId);
      if (!pending || pending.promise !== promise) return;
      clearTimeout(pending.timer);
      this.pendingInputs.delete(commandId);
      const result = error ?? { accepted: true as const };
      this.completedInputs.set(commandId, { ...request, socket, result });
      if (this.completedInputs.size > INPUT_RESULT_LIMIT) {
        this.completedInputs.delete(this.completedInputs.keys().next().value!);
      }
      if (error) reject(error);
      else resolve(result as { accepted: true });
    };
    const timer = setTimeout(() => settle(new GatewayTimeoutException('shortcut input acknowledgement timed out; delivery is unknown')), INPUT_ACK_TIMEOUT_MS);
    this.pendingInputs.set(commandId, { ...request, socket, promise, settle, timer });
    try {
      this.send(socket, run.deviceId, 'shortcut.run.input', { runId, commandId, answer }, (error) => {
        if (error) settle(new ConflictException(UNKNOWN_INPUT_DELIVERY));
      });
    } catch {
      settle(new ConflictException(UNKNOWN_INPUT_DELIVERY));
    }
    return promise;
  }

  acknowledgeInput(socket: WebSocket, deviceId: string, payload: ShortcutRunInputAckPayload): boolean {
    const commandId = payload.commandId.toLowerCase();
    const pending = this.pendingInputs.get(commandId);
    if (!pending) {
      const completed = this.completedInputs.get(commandId);
      if (!completed || completed.runId !== payload.runId.toLowerCase()
        || completed.deviceId !== deviceId || completed.socket !== socket
        || this.registry.getClient(deviceId) !== socket || socket.readyState !== WebSocket.OPEN) return false;
      if (completed.result instanceof GatewayTimeoutException) {
        completed.result = payload.status === 'rejected'
          ? new ConflictException(payload.message || 'shortcut input rejected by device')
          : { accepted: true };
      }
      return true;
    }
    if (pending.runId !== payload.runId.toLowerCase()
      || pending.deviceId !== deviceId || pending.socket !== socket
      || this.registry.getClient(deviceId) !== socket || socket.readyState !== WebSocket.OPEN) return false;
    pending.settle(payload.status === 'rejected'
      ? new ConflictException(payload.message || 'shortcut input rejected by device') : undefined);
    return true;
  }

  private inputResult(runId: string, commandId: string, answer: ShortcutRunInputPayload['answer']): Promise<{ accepted: true }> | undefined {
    const pending = this.pendingInputs.get(commandId);
    const completed = this.completedInputs.get(commandId);
    const request = pending ?? completed;
    if (!request) return undefined;
    if (request.runId !== runId || request.answer !== answer) {
      throw new ConflictException('commandId belongs to another shortcut input');
    }
    if (pending) return pending.promise;
    return completed!.result instanceof Error
      ? Promise.reject(completed!.result) : Promise.resolve(completed!.result);
  }

  async disconnected(deviceId: string): Promise<void> {
    this.failInputs(deviceId);
    for (const [id, state] of this.runningWrites) {
      if (state.deviceId === deviceId) {
        if (state.timer) clearTimeout(state.timer);
        this.runningWrites.delete(id);
      }
    }
    await this.store.failActive(deviceId, UNKNOWN_EXECUTION_RESULT);
  }

  private failInputs(deviceId: string): void {
    for (const pending of this.pendingInputs.values()) {
      if (pending.deviceId === deviceId) pending.settle(new ConflictException(UNKNOWN_INPUT_DELIVERY));
    }
  }

  private connected(deviceId: string): WebSocket | undefined {
    const socket = this.registry.getClient(deviceId);
    return socket?.readyState === WebSocket.OPEN ? socket : undefined;
  }

  private send(
    socket: WebSocket, deviceId: string,
    type: 'shortcut.run.start' | 'shortcut.run.cancel' | 'shortcut.run.input',
    payload: ShortcutRunStartPayload | ShortcutRunCancelPayload | ShortcutRunInputPayload,
    onSent?: (error?: Error) => void,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('device offline');
    socket.send(JSON.stringify({
      event: 'message',
      data: { type, protocolVersion: '2', messageId: randomUUID(),
        deviceId, sentAt: new Date().toISOString(), payload },
    }), (error) => {
      if (error && !onSent && this.registry.getClient(deviceId) === socket) void this.disconnected(deviceId);
      onSent?.(error || undefined);
    });
  }
}
