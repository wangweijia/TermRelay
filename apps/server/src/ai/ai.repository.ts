import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AIProjectKeyEntity, AIResourceEntity } from './ai.entity';

@Injectable()
export class AIRepository {
  private resources = new Map<string, AIResourceEntity>();
  readonly keys = new Map<string, AIProjectKeyEntity>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(@Optional() @InjectDataSource() private readonly db?: DataSource) {}
  get persistent(): boolean { return !!this.db; }

  async key(hash: string): Promise<AIProjectKeyEntity | null> {
    return this.db ? this.db.getRepository(AIProjectKeyEntity).findOneBy({ keyHash: hash, revoked: false })
      : [...this.keys.values()].find(k => k.keyHash === hash && !k.revoked) ?? null;
  }

  async keyTransaction<T>(fn: (keys: Map<string, AIProjectKeyEntity>) => T): Promise<T> {
    const run = this.tail.then(async () => {
      if (!this.db) {
        const rows = new Map([...this.keys].map(([id,key]) => [id,structuredClone(key)]));
        const result = fn(rows);
        this.keys.clear();
        for (const [id,key] of rows) this.keys.set(id,key);
        return result;
      }
      return this.db.transaction(async manager => {
        await manager.query('SELECT id FROM ai_service_mutex WHERE id = 1 FOR UPDATE');
        const repo = manager.getRepository(AIProjectKeyEntity);
        const rows = new Map((await repo.find()).map(key => [key.id,key]));
        const before = new Map([...rows].map(([id,key]) => [id,JSON.stringify(key)]));
        const result = fn(rows);
        for (const [id,key] of rows) if (before.get(id) !== JSON.stringify(key)) await repo.save(key);
        return result;
      });
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async pruneSessionData(): Promise<void> {
    if (!this.db) return;
    await this.db.query("DELETE e FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.origin = 'external' AND e.expires_at < CURRENT_TIMESTAMP(3)");
    await this.db.query("DELETE a FROM approvals a JOIN sessions s ON s.id = a.session_id WHERE s.origin = 'external' AND a.expires_at < CURRENT_TIMESTAMP(3)");
    await this.db.query("DELETE c FROM commands c JOIN sessions s ON s.id = c.session_id WHERE s.origin = 'external' AND s.status IN ('finished','failed') AND s.finished_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)");
    await this.db.query("DELETE FROM sessions WHERE origin = 'external' AND status IN ('finished','failed') AND finished_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)");
  }

  async transaction<T>(fn: (rows: Map<string, AIResourceEntity>) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (!this.db) {
        const rows = new Map([...this.resources].map(([id, row]) => [id, structuredClone(row)]));
        const result = await fn(rows);
        this.resources = rows;
        return result;
      }
      return this.db.transaction(async manager => {
        // Serialize admission, idempotency and terminal arbitration across Server processes.
        await manager.query('SELECT id FROM ai_service_mutex WHERE id = 1 FOR UPDATE');
        const repo = manager.getRepository(AIResourceEntity);
        const rows = new Map((await repo.find()).map(row => [row.id, row]));
        const before = new Map([...rows].map(([id,row]) => [id, JSON.stringify(row)]));
        const result = await fn(rows);
        for (const [id,row] of rows) if (JSON.stringify(row) !== before.get(id)) await repo.save(row);
        for (const id of before.keys()) if (!rows.has(id)) await repo.delete(id);
        return result;
      });
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
