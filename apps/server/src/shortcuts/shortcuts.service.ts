import {
  ConflictException, Injectable, NotFoundException, OnModuleDestroy,
  OnModuleInit, ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ShortcutCatalogPayload, ShortcutRunUpdatePayload, ShortcutRunStartPayload,
  ShortcutRunCancelPayload,
} from '@termrelay/contracts';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DeviceConnectionRegistry } from '../realtime/device-connection.registry';
import {
  ShortcutsRepository, UNKNOWN_EXECUTION_RESULT,
  type ShortcutRecord, type ShortcutRunRecord,
} from './shortcuts.repository';

const RUNNING_WRITE_INTERVAL_MS = 250;

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

  constructor(
    private readonly store: ShortcutsRepository,
    private readonly registry: DeviceConnectionRegistry,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.registry.subscribe((device) => {
      if (device.presence === 'offline') {
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

  async disconnected(deviceId: string): Promise<void> {
    for (const [id, state] of this.runningWrites) {
      if (state.deviceId === deviceId) {
        if (state.timer) clearTimeout(state.timer);
        this.runningWrites.delete(id);
      }
    }
    await this.store.failActive(deviceId, UNKNOWN_EXECUTION_RESULT);
  }

  private connected(deviceId: string): WebSocket | undefined {
    const socket = this.registry.getClient(deviceId);
    return socket?.readyState === WebSocket.OPEN ? socket : undefined;
  }

  private send(
    socket: WebSocket, deviceId: string,
    type: 'shortcut.run.start' | 'shortcut.run.cancel',
    payload: ShortcutRunStartPayload | ShortcutRunCancelPayload,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('device offline');
    socket.send(JSON.stringify({
      event: 'message',
      data: { type, protocolVersion: '2', messageId: randomUUID(),
        deviceId, sentAt: new Date().toISOString(), payload },
    }), (error) => {
      if (error) void this.disconnected(deviceId);
    });
  }
}
