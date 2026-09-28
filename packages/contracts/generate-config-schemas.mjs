import { readFile, writeFile } from 'node:fs/promises';

const indexURL = new URL('./generated/typescript/index.ts', import.meta.url);
let source = await readFile(indexURL, 'utf8');
for (const [name, path, next] of [
  ['toolEventSchema', './events/tool-event.schema.json', 'toolTurnStartSchema'],
  ['toolConfigSetSchema', './commands/tool-config-set.schema.json', 'toolTurnStartSchema'],
]) {
  const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const declaration = `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
  const start = source.indexOf(`export const ${name} = `);
  const end = source.indexOf(`export const ${next} = `);
  if (end < 0 || (start >= 0 && start > end)) throw new Error(`Missing ${next} export`);
  if (start >= 0) {
    source = source.slice(0, start) + declaration + source.slice(end);
  } else {
    source = source.slice(0, end) + declaration + source.slice(end);
  }
}
const historySchemas = [
  ['sessionHistoryListSchema', 'session-history-list'],
  ['sessionHistoryListedSchema', 'session-history-listed'],
  ['sessionHistoryRequestSchema', 'session-history-request'],
  ['sessionHistorySchema', 'session-history'],
  ['sessionHistoryDeleteSchema', 'session-history-delete'],
  ['sessionHistoryDeletedSchema', 'session-history-deleted'],
];
const historyTypes = `export interface SessionHistoryListPayload {
  cursor?: string;
}

export interface SessionHistoryEntry {
  id: string;
  workspaceId: string;
  toolKey: string;
  displayName: string | null;
  runtimeMode: 'acp';
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'failed';
  startedAt: string | null;
  updatedAt: string;
}

export interface SessionHistoryListedPayload {
  sessions: SessionHistoryEntry[];
  hasMore: boolean;
  relatedMessageId: string;
  nextCursor?: string;
}

export interface SessionHistoryRequestPayload {
  beforeSeq?: number;
  limit?: number;
}

export interface SessionHistoryEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionHistoryPayload {
  events: SessionHistoryEvent[];
  hasMore: boolean;
  relatedMessageId: string;
}

export interface SessionHistoryDeletePayload {
  purge: boolean;
}

export interface SessionHistoryDeletedPayload {
  purged: boolean;
  relatedMessageId: string;
}

`;
const historyDeclarations = await Promise.all(historySchemas.map(async ([name, file]) => {
  const schema = JSON.parse(await readFile(new URL(`./events/${file}.schema.json`, import.meta.url), 'utf8'));
  return `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}));
const marker = 'export interface SessionHistoryListPayload';
const start = source.indexOf(marker);
if (start >= 0) source = source.slice(0, start);
await writeFile(indexURL, source + historyTypes + historyDeclarations.join('').trimEnd() + '\n');