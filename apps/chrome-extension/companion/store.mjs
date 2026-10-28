import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Store {
  constructor(path) { this.path = path; this.records = []; this.tail = Promise.resolve(); }

  async load() {
    try { this.records = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.records)) throw new Error('Invalid feedback store.');
    let changed = false;
    for (const record of this.records) {
      if (['sending', 'running', 'awaiting_approval', 'awaiting_input'].includes(record.status)) {
        record.status = 'unknown';
        record.note = 'Companion restarted during delivery. Verify in TermRelay; do not resend automatically.';
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async save() {
    const data = JSON.stringify(this.records, null, 2);
    this.tail = this.tail.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, data, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    await this.tail;
  }
}
