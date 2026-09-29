import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { ShortcutCatalogEntry, ShortcutRunUpdatePayload } from '@termrelay/contracts';
import { DataSource, In, LessThan } from 'typeorm';
import { ShortcutEntity } from './shortcut.entity';
import { ShortcutRunEntity, type ShortcutRunStatus } from './shortcut-run.entity';

export interface ShortcutRecord extends ShortcutCatalogEntry {
  deviceId: string;
  online: boolean;
}

export interface ShortcutRunRecord {
  id: string;
  shortcutId: string;
  deviceId: string;
  status: ShortcutRunStatus;
  exitCode: number | null;
  output: string;
  createdAt: string;
  updatedAt: string;
}

const active: ShortcutRunStatus[] = ['queued', 'running'];
const terminal: ShortcutRunStatus[] = ['succeeded', 'failed', 'cancelled'];
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const UNKNOWN_EXECUTION_RESULT = '连接中断，执行结果未知；请核实后再运行';

@Injectable()
export class ShortcutsRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShortcutsRepository.name);
  private readonly shortcuts = new Map<string, ShortcutEntity>();
  private readonly runs = new Map<string, ShortcutRunEntity>();
  private pruneTimer?: NodeJS.Timeout;

  constructor(@Optional() @InjectDataSource() private readonly db?: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (!this.db) return;
    await this.db.getRepository(ShortcutRunEntity).update(
      { status: In(active) },
      { status: 'failed', output: UNKNOWN_EXECUTION_RESULT, activeShortcutId: null },
    );
    await this.pruneFinishedRuns();
    this.pruneTimer = setInterval(() => {
      void this.pruneFinishedRuns().catch((error: unknown) => {
        this.logger.warn(`Could not prune old shortcut runs: ${String(error)}`);
      });
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  async pruneFinishedRuns(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RUN_RETENTION_MS);
    if (!this.db) {
      for (const [id, run] of this.runs) {
        if (terminal.includes(run.status) && run.updatedAt < cutoff) this.runs.delete(id);
      }
      return;
    }
    await this.db.getRepository(ShortcutRunEntity).delete({
      status: In(terminal), updatedAt: LessThan(cutoff),
    });
  }

  async replaceCatalog(deviceId: string, shortcuts: ShortcutCatalogEntry[]): Promise<boolean> {
    if (!this.db) {
      if (shortcuts.some((entry) => {
        const owner = this.shortcuts.get(entry.id.toLowerCase());
        return owner && owner.deviceId !== deviceId;
      })) return false;
      for (const [id, entry] of this.shortcuts) {
        if (entry.deviceId === deviceId) this.shortcuts.delete(id);
      }
      for (const entry of shortcuts) {
        this.shortcuts.set(entry.id.toLowerCase(), { ...entry, id: entry.id.toLowerCase(), deviceId });
      }
      return true;
    }
    try {
      return await this.db.transaction(async (manager) => {
        const ids = shortcuts.map((entry) => entry.id.toLowerCase());
        if (ids.length) {
          const existing = await manager.getRepository(ShortcutEntity).findBy({ id: In(ids) });
          if (existing.some((entry) => entry.deviceId !== deviceId)) return false;
        }
        const repo = manager.getRepository(ShortcutEntity);
        if (ids.length) {
          await repo.createQueryBuilder().delete().where('device_id = :deviceId', { deviceId })
            .andWhere('id NOT IN (:...ids)', { ids }).execute();
          const known = new Set((await repo.findBy({ id: In(ids) })).map((entry) => entry.id));
          for (const entry of shortcuts) {
            const id = entry.id.toLowerCase();
            if (known.has(id)) {
              const result = await repo.update({ id, deviceId }, { ...entry, id, deviceId });
              if (!result.affected) throw new CatalogOwnershipConflict();
            } else {
              await repo.insert({ ...entry, id, deviceId });
            }
          }
        } else {
          await repo.delete({ deviceId });
        }
        return true;
      });
    } catch (error) {
      if (isDuplicate(error) || error instanceof CatalogOwnershipConflict) return false;
      throw error;
    }
  }

  async list(): Promise<ShortcutEntity[]> {
    return this.db
      ? this.db.getRepository(ShortcutEntity).find({ order: { name: 'ASC' } })
      : [...this.shortcuts.values()];
  }

  async findShortcut(id: string): Promise<ShortcutEntity | undefined> {
    const entry = this.db
      ? await this.db.getRepository(ShortcutEntity).findOneBy({ id: id.toLowerCase() })
      : this.shortcuts.get(id.toLowerCase());
    return entry ?? undefined;
  }

  async findRun(id: string): Promise<ShortcutRunRecord | undefined> {
    const run = this.db
      ? await this.db.getRepository(ShortcutRunEntity).findOneBy({ id: id.toLowerCase() })
      : this.runs.get(id.toLowerCase());
    return run ? toRecord(run) : undefined;
  }

  async listRuns(limit: number): Promise<ShortcutRunRecord[]> {
    const runs = this.db
      ? await this.db.getRepository(ShortcutRunEntity).find({
          order: { createdAt: 'DESC', id: 'DESC' },
          take: limit,
        })
      : [...this.runs.values()]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
            || right.id.localeCompare(left.id))
          .slice(0, limit);
    return runs.map(toRecord);
  }

  async createRun(id: string, shortcut: ShortcutEntity): Promise<'created' | 'duplicate' | 'busy'> {
    const key = id.toLowerCase();
    if (!this.db) {
      if (this.runs.has(key)) return 'duplicate';
      if ([...this.runs.values()].some((run) => run.activeShortcutId === shortcut.id)) return 'busy';
      const now = new Date();
      this.runs.set(key, {
        id: key, shortcutId: shortcut.id, deviceId: shortcut.deviceId,
        status: 'queued', exitCode: null, output: '', activeShortcutId: shortcut.id,
        cancelRequested: false, createdAt: now, updatedAt: now,
      });
      return 'created';
    }
    const repo = this.db.getRepository(ShortcutRunEntity);
    try {
      await repo.insert({
        id: key, shortcutId: shortcut.id, deviceId: shortcut.deviceId,
        status: 'queued', exitCode: null, output: '', activeShortcutId: shortcut.id,
        cancelRequested: false,
      });
      return 'created';
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      return await this.findRun(key) ? 'duplicate' : 'busy';
    }
  }

  async updateRun(deviceId: string, update: ShortcutRunUpdatePayload): Promise<ShortcutRunRecord | undefined> {
    if (update.output !== undefined && Array.from(update.output).length > 32_768) return undefined;
    const id = update.runId.toLowerCase();
    const current = await this.findRun(id);
    if (!current || current.deviceId !== deviceId || !active.includes(current.status)) {
      return undefined;
    }
    const terminal = update.status !== 'running';
    const values = {
      status: update.status,
      ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
      ...(update.output !== undefined ? { output: update.output } : {}),
      ...(terminal ? { activeShortcutId: null } : {}),
      updatedAt: new Date(),
    };
    if (!this.db) {
      const run = this.runs.get(id)!;
      if (!active.includes(run.status)) return undefined;
      Object.assign(run, values);
    } else {
      const result = await this.db.getRepository(ShortcutRunEntity).update(
        { id, deviceId, status: In(active) }, values,
      );
      if (!result.affected) return undefined;
    }
    return this.findRun(id);
  }

  async requestCancel(id: string): Promise<void> {
    if (!this.db) {
      const run = this.runs.get(id.toLowerCase());
      if (run) run.cancelRequested = true;
    } else {
      await this.db.getRepository(ShortcutRunEntity).update({ id: id.toLowerCase(), status: In(active) }, { cancelRequested: true });
    }
  }

  async failRun(id: string, reason: string): Promise<void> {
    const key = id.toLowerCase();
    if (!this.db) {
      const run = this.runs.get(key);
      if (run && active.includes(run.status)) {
        Object.assign(run, { status: 'failed', output: reason, activeShortcutId: null, updatedAt: new Date() });
      }
    } else {
      await this.db.getRepository(ShortcutRunEntity).update(
        { id: key, status: In(active) },
        { status: 'failed', output: reason, activeShortcutId: null },
      );
    }
  }

  async failActive(deviceId: string, reason: string): Promise<void> {
    if (!this.db) {
      for (const run of this.runs.values()) {
        if (run.deviceId === deviceId && active.includes(run.status)) {
          Object.assign(run, { status: 'failed', output: reason, activeShortcutId: null, updatedAt: new Date() });
        }
      }
    } else {
      await this.db.getRepository(ShortcutRunEntity).update(
        { deviceId, status: In(active) },
        { status: 'failed', output: reason, activeShortcutId: null },
      );
    }
  }
}

function toRecord(run: ShortcutRunEntity): ShortcutRunRecord {
  return {
    id: run.id, shortcutId: run.shortcutId, deviceId: run.deviceId,
    status: run.status, exitCode: run.exitCode, output: run.output,
    createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
  };
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'driverError' in error
    && (error.driverError as { code?: string })?.code === 'ER_DUP_ENTRY';
}

class CatalogOwnershipConflict extends Error {}
