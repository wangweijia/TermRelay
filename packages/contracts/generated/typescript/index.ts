// Generated-file boundary. Replace this bootstrap with schema code generation.
export type ProtocolVersion = '1';

export interface Envelope<TPayload = Record<string, unknown>> {
  type: string;
  protocolVersion: ProtocolVersion;
  messageId: string;
  deviceId: string;
  sessionId?: string;
  commandId?: string;
  seq?: number;
  sentAt: string;
  payload: TPayload;
}

export interface DeviceRegisterPayload {
  name: string;
  appVersion: string;
  platform: 'macOS';
  tools: string[];
}

export interface DeviceRegisteredPayload {
  registeredAt: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface DeviceHeartbeatPayload {
  connectionState: 'connected' | 'degraded';
  activeSessionCount?: number;
}

export interface WorkspaceRegisteredPayload {
  workspaceId: string;
  displayName: string;
  available: boolean;
  remoteStartAllowed: boolean;
}

export type SessionRuntimeMode = 'terminal' | 'structured';

export interface SessionStartedPayload {
  workspaceId: string;
  toolKey: string;
  runtimeMode: SessionRuntimeMode;
  startedAt: string;
}

export type ProtocolErrorCode =
  | 'invalid_message'
  | 'unsupported_version'
  | 'unknown_device'
  | 'unknown_session'
  | 'unauthorized_workspace'
  | 'conflict'
  | 'internal_error';

export interface ProtocolErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  relatedMessageId?: string;
}

// Runtime schema exports are generated-file artifacts derived from the JSON Schema source.
export const envelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/envelope.schema.json',
  title: 'TermRelay message envelope',
  type: 'object',
  required: ['type', 'protocolVersion', 'messageId', 'deviceId', 'sentAt', 'payload'],
  properties: {
    type: { type: 'string', minLength: 1 },
    protocolVersion: { const: '1' },
    messageId: { type: 'string', format: 'uuid' },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    sessionId: { type: 'string', minLength: 1, maxLength: 128 },
    commandId: { type: 'string', format: 'uuid' },
    seq: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sentAt: { type: 'string', format: 'date-time' },
    payload: { type: 'object' },
  },
  additionalProperties: false,
} as const;

export const deviceRegisterSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/device-register.schema.json',
  title: 'device.register payload',
  type: 'object',
  required: ['name', 'appVersion', 'platform', 'tools'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    appVersion: { type: 'string', minLength: 1 },
    platform: { const: 'macOS' },
    tools: {
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    },
  },
  additionalProperties: false,
} as const;

export const deviceHeartbeatSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/device-heartbeat.schema.json',
  title: 'device.heartbeat payload',
  type: 'object',
  required: ['connectionState'],
  properties: {
    connectionState: { enum: ['connected', 'degraded'] },
    activeSessionCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

export const workspaceRegisteredSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/workspace-registered.schema.json',
  title: 'workspace.registered payload',
  type: 'object',
  required: ['workspaceId', 'displayName', 'available', 'remoteStartAllowed'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    displayName: { type: 'string', minLength: 1, maxLength: 255 },
    available: { type: 'boolean' },
    remoteStartAllowed: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

export const sessionStartedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/session-started.schema.json',
  title: 'session.started payload',
  type: 'object',
  required: ['workspaceId', 'toolKey', 'runtimeMode', 'startedAt'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    toolKey: { type: 'string', minLength: 1, maxLength: 64 },
    runtimeMode: { enum: ['terminal', 'structured'] },
    startedAt: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

export interface TerminalOutputPayload {
  encoding: 'base64';
  data: string;
}

export interface SessionSubscribePayload {
  afterSeq?: number;
}

export type SessionUnsubscribePayload = Record<string, never>;

export const terminalOutputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/events/terminal-output.schema.json',
  title: 'terminal.output payload',
  type: 'object',
  required: ['encoding', 'data'],
  properties: {
    encoding: { const: 'base64' },
    data: {
      type: 'string',
      minLength: 4,
      maxLength: 1_398_104,
      contentEncoding: 'base64',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    },
  },
  additionalProperties: false,
} as const;

export const sessionSubscribeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/web/session-subscribe.schema.json',
  title: 'session.subscribe payload',
  type: 'object',
  properties: {
    afterSeq: {
      type: 'integer',
      minimum: -1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  additionalProperties: false,
} as const;

export const sessionUnsubscribeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://termrelay.local/contracts/web/session-unsubscribe.schema.json',
  title: 'session.unsubscribe payload',
  type: 'object',
  maxProperties: 0,
  additionalProperties: false,
} as const;

export type CommandStatus = 'accepted' | 'completed' | 'rejected' | 'failed';

export interface CommandAckPayload {
  commandId: string;
  status: CommandStatus;
  errorCode?: string;
  message?: string;
}
