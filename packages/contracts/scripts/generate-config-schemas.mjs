import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const indexURL = new URL('./generated/typescript/index.ts', root);
let source = await readFile(indexURL, 'utf8');
for (const [name, path, next] of [
  ['deviceRegisterSchema', './events/device-register.schema.json', 'deviceHeartbeatSchema'],
  ['toolEventSchema', './events/tool-event.schema.json', 'toolTurnStartSchema'],
  ['toolConfigSetSchema', './commands/tool-config-set.schema.json', 'toolTurnStartSchema'],
  ['sessionStartedSchema', './events/session-started.schema.json', 'sessionEndedSchema'],
  ['sessionStartSchema', './commands/session-start.schema.json', 'terminalInputSchema'],
  ['workspaceRegisteredSchema', './events/workspace-registered.schema.json', 'sessionStartedSchema'],
]) {
  const schema = JSON.parse(await readFile(new URL(path, root), 'utf8'));
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
const deviceRegister = JSON.parse(await readFile(new URL('./events/device-register.schema.json', root), 'utf8'));
const toolEvent = JSON.parse(await readFile(new URL('./events/tool-event.schema.json', root), 'utf8'));
source = source.replace(/export type ToolEventKind =[\s\S]*?;/,
  `export type ToolEventKind = ${toolEvent.properties.kind.enum.map(value => JSON.stringify(value)).join(' | ')};`);
source = source.replace(/export interface DeviceRegisterPayload \{[\s\S]*?\n\}/, `export interface DeviceRegisterPayload {
  name: string;
  appVersion: string;
  platform: ${deviceRegister.properties.platform.enum.map(value => JSON.stringify(value)).join(' | ')};
  tools: string[];
}`);
const historySchemas = [
  ['sessionHistoryListSchema', 'session-history-list'],
  ['sessionHistoryListedSchema', 'session-history-listed'],
  ['sessionHistoryRequestSchema', 'session-history-request'],
  ['sessionHistorySchema', 'session-history'],
  ['sessionHistoryDeleteSchema', 'session-history-delete'],
  ['sessionHistoryDeletedSchema', 'session-history-deleted'],
];
const shortcutSchemas = [
  ['shortcutCatalogSchema', 'shortcut-catalog'],
  ['shortcutRunUpdateSchema', 'shortcut-run-update'],
  ['shortcutRunStartSchema', 'shortcut-run-start'],
  ['shortcutRunCancelSchema', 'shortcut-run-cancel'],
  ['shortcutRunInputSchema', 'shortcut-run-input'],
  ['shortcutRunInputAckSchema', 'shortcut-run-input-ack'],
];
const filePreviewSchemas = [
  ['filePreviewRequestSchema', 'commands/file-preview-request'],
  ['filePreviewResultSchema', 'events/file-preview-result'],
];
const filePreviewTypes = `export interface FilePreviewRequestPayload {
  requestId: string;
  workspaceId: string;
  path: string;
}

export interface FilePreviewResultPayload {
  requestId: string;
  status: 'ok' | 'not_found' | 'forbidden' | 'too_large' | 'unsupported' | 'error';
  name?: string;
  content?: string;
}

`;
const shortcutTypes = `export interface ShortcutCatalogEntry {
  id: string;
  revision: number;
  name: string;
  description: string;
  workspaceId: string;
  proxyMode: 'inherit' | 'disabled' | 'custom';
  requiresConfirmation: boolean;
}

export interface ShortcutCatalogPayload {
  shortcuts: ShortcutCatalogEntry[];
}

export interface ShortcutRunUpdatePayload {
  runId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  exitCode?: number;
  output?: string;
}

export interface ShortcutRunStartPayload {
  runId: string;
  shortcutId: string;
  revision: number;
}

export interface ShortcutRunCancelPayload {
  runId: string;
}

export interface ShortcutRunInputPayload {
  runId: string;
  commandId: string;
  answer: 'y' | 'n' | 'yes' | 'no';
}

export interface ShortcutRunInputAckPayload {
  runId: string;
  commandId: string;
  status: 'accepted' | 'rejected';
  message?: string;
}

`;
const historyTypes = `export interface SessionHistoryListPayload {
  scope?: 'copilot' | 'external';
  cursor?: string;
}

export interface SessionHistoryEntry {
  projectId?: string | null;
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
  const schema = JSON.parse(await readFile(new URL(`./events/${file}.schema.json`, root), 'utf8'));
  return `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}));
const marker = 'export interface SessionHistoryListPayload';
const sessionStartType = `export interface SessionStartPayload {
  workspaceId: string;
  toolKey: string;
  runtimeMode: SessionRuntimeMode;
  rows?: number;
  columns?: number;
  displayName?: string;
}`;
source = source.includes('export interface SessionStartPayload')
  ? source.replace(/export interface SessionStartPayload \{[\s\S]*?\n\}/, sessionStartType)
  : source.replace('export interface SessionStartedPayload', sessionStartType + '\n\nexport interface SessionStartedPayload');
source = source.replace(/export interface WorkspaceRegisteredPayload \{[\s\S]*?\n\}/, `export interface WorkspaceRegisteredPayload {
  workspaceId: string;
  displayName: string;
  available: boolean;
  remoteStartAllowed: boolean;
  launchOptions?: { toolKey: string; runtimeMode: SessionRuntimeMode }[];
}`);
source = source.replace(/export interface SessionStartedPayload \{[\s\S]*?\n\}/, `export interface SessionStartedPayload {
  workspaceId: string;
  toolKey: string;
  displayName?: string;
  runtimeMode: SessionRuntimeMode;
  startedAt: string;
  origin?: 'local' | 'external';
  projectId?: string;
  aiResourceId?: string;
}`);
const start = source.indexOf(marker);
if (start >= 0) source = source.slice(0, start);
const shortcutDeclarations = await Promise.all(shortcutSchemas.map(async ([name, file]) => {
  const schema = JSON.parse(await readFile(new URL(`./events/${file}.schema.json`, root), 'utf8'));
  return `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}));
const filePreviewDeclarations = await Promise.all(filePreviewSchemas.map(async ([name, file]) => {
  const schema = JSON.parse(await readFile(new URL(`./${file}.schema.json`, root), 'utf8'));
  return `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}));
await import('./generate-ai.mjs');
await writeFile(indexURL, source + historyTypes + historyDeclarations.join('') + shortcutTypes + shortcutDeclarations.join('') + filePreviewTypes + filePreviewDeclarations.join('').trimEnd() + '\nexport * from "./ai.js";\n');

const swiftURL = new URL('./generated/swift/ProtocolTypes.swift', root);
let swift = await readFile(swiftURL, 'utf8');
swift = swift.replace(/public struct WorkspaceRegisteredPayload:[\s\S]*?\n\}/, `public struct WorkspaceRegisteredPayload: Codable, Sendable {
    public let workspaceId: String
    public let displayName: String
    public let available: Bool
    public let remoteStartAllowed: Bool
    public let launchOptions: [SessionLaunchOption]?
}`);
const swiftStart = `public struct SessionLaunchOption: Codable, Sendable {
    public let toolKey: String
    public let runtimeMode: SessionRuntimeMode
}

public struct SessionStartPayload: Codable, Sendable {
    public let workspaceId: String
    public let toolKey: String
    public let runtimeMode: SessionRuntimeMode
    public let displayName: String?
    public let rows: Int?
    public let columns: Int?
}

`;
swift = swift.replace(/public struct SessionLaunchOption:[\s\S]*?(?=public struct SessionStartedPayload)/, '');
swift = swift.replace('public struct SessionStartedPayload', swiftStart + 'public struct SessionStartedPayload');
await writeFile(swiftURL, swift);
