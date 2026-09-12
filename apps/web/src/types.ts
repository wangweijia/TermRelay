export interface SessionRecord {
  id: string;
  deviceId: string;
  workspaceId: string;
  toolKey: string;
  displayName: string | null;
  runtimeMode: 'terminal' | 'structured';
  webDisplayMode?: 'approval' | 'full';
  status: 'starting' | 'running' | 'stopping' | 'finished' | 'failed';
  stateVersion: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  id: string;
  status: 'connected' | 'connecting' | 'offline' | 'degraded';
  activeSessionCount: number;
  disconnectedAt?: string;
}

export interface SessionEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ToolEventKind =
  | 'turn.started' | 'assistant.delta' | 'reasoning.delta'
  | 'command.started' | 'command.output' | 'command.completed'
  | 'file.changed' | 'approval.requested' | 'approval.resolved'
  | 'plan.updated' | 'turn.completed' | 'warning' | 'error';

export interface ToolEventPayload {
  kind: ToolEventKind;
  occurredAt: string;
  correlation: { turnId?: string; itemId?: string; approvalId?: string };
  data: Record<string, unknown>;
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

export interface SessionUpdatedPayload {
  session: SessionRecord;
}
