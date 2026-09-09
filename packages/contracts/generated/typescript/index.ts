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

