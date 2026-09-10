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
    seq: { type: 'integer', minimum: 0 },
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

export interface TerminalOutputPayload {
  encoding: 'base64';
  data: string;
}

export type CommandStatus = 'accepted' | 'completed' | 'rejected' | 'failed';

export interface CommandAckPayload {
  commandId: string;
  status: CommandStatus;
  errorCode?: string;
  message?: string;
}
