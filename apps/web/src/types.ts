export interface SessionRecord {
  id: string;
  deviceId: string;
  workspaceId: string;
  toolKey: string;
  runtimeMode: 'terminal' | 'structured';
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'failed';
  stateVersion: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WireEnvelope<TPayload = Record<string, unknown>> {
  type: string;
  protocolVersion: '1';
  messageId: string;
  deviceId: string;
  sessionId?: string;
  commandId?: string;
  seq?: number;
  sentAt: string;
  payload: TPayload;
}

export interface CommandAckPayload {
  commandId: string;
  status: 'accepted' | 'completed' | 'rejected' | 'failed';
  errorCode?: string;
  message?: string;
}

export interface SessionSubscribedPayload {
  session: SessionRecord;
  events: SessionEventRecord[];
  latestSeq: number;
}
