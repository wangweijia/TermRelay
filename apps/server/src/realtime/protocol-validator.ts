import { Injectable } from '@nestjs/common';
import type {
  CommandAckPayload,
  DeviceHeartbeatPayload,
  DeviceRegisterPayload,
  Envelope,
  SessionEndedPayload,
  SessionHistoryListPayload,
  SessionHistoryRequestPayload,
  SessionHistoryDeletePayload,
  SessionSyncPayload,
  SessionStartedPayload,
  TerminalOutputPayload,
  ToolEventPayload,
  WorkspaceRegisteredPayload,
  ShortcutCatalogPayload,
  ShortcutRunUpdatePayload,
  ShortcutRunInputAckPayload,
  FilePreviewResultPayload,
} from '@termrelay/contracts';
import {
  commandAckSchema,
  deviceHeartbeatSchema,
  deviceRegisterSchema,
  sessionEndedSchema,
  sessionHistoryListSchema,
  sessionHistoryRequestSchema,
  sessionHistoryDeleteSchema,
  sessionSyncSchema,
  sessionStartedSchema,
  terminalOutputSchema,
  toolEventSchema,
  workspaceRegisteredSchema,
  shortcutCatalogSchema,
  shortcutRunUpdateSchema,
  shortcutRunInputAckSchema,
  filePreviewResultSchema,
} from '@termrelay/contracts';
import { aiCapabilitiesSchema, aiUpdateSchema, type AiCapabilities, type AiUpdate } from '@termrelay/contracts';
import { ProtocolSchemaValidator, type SchemaValidationResult } from './protocol-schema-validator';

export type ValidClientMessage =
  | { type: 'ai.capabilities'; envelope: Envelope<AiCapabilities> }
  | { type: 'ai.update'; envelope: Envelope<AiUpdate> }
  | { type: 'device.register'; envelope: Envelope<DeviceRegisterPayload> }
  | { type: 'device.heartbeat'; envelope: Envelope<DeviceHeartbeatPayload> }
  | {
      type: 'workspace.registered';
      envelope: Envelope<WorkspaceRegisteredPayload>;
    }
  | { type: 'session.started'; envelope: Envelope<SessionStartedPayload> }
  | { type: 'session.ended'; envelope: Envelope<SessionEndedPayload> }
  | { type: 'session.sync'; envelope: Envelope<SessionSyncPayload> }
  | { type: 'session.history.list'; envelope: Envelope<SessionHistoryListPayload> }
  | { type: 'session.history.request'; envelope: Envelope<SessionHistoryRequestPayload> }
  | { type: 'session.history.delete'; envelope: Envelope<SessionHistoryDeletePayload> }
  | { type: 'terminal.output'; envelope: Envelope<TerminalOutputPayload> }
  | { type: 'tool.event'; envelope: Envelope<ToolEventPayload> }
  | { type: 'command.ack'; envelope: Envelope<CommandAckPayload> }
  | { type: 'shortcut.catalog'; envelope: Envelope<ShortcutCatalogPayload> }
  | { type: 'shortcut.run.update'; envelope: Envelope<ShortcutRunUpdatePayload> }
  | { type: 'shortcut.run.input.ack'; envelope: Envelope<ShortcutRunInputAckPayload> }
  | { type: 'file.preview.result'; envelope: Envelope<FilePreviewResultPayload> };

export type ProtocolValidationResult = SchemaValidationResult<ValidClientMessage>;

@Injectable()
export class ProtocolValidator {
  private readonly schemas = new ProtocolSchemaValidator<ValidClientMessage>('client', {
    'ai.capabilities': aiCapabilitiesSchema,
    'ai.update': aiUpdateSchema,
    'device.register': deviceRegisterSchema,
    'device.heartbeat': deviceHeartbeatSchema,
    'workspace.registered': workspaceRegisteredSchema,
    'session.started': sessionStartedSchema,
    'session.ended': sessionEndedSchema,
    'session.sync': {
      ...sessionSyncSchema,
      properties: { autoApproveEnabled: { type: 'boolean' } },
      maxProperties: 1,
    },
    'session.history.list': sessionHistoryListSchema,
    'session.history.request': sessionHistoryRequestSchema,
    'session.history.delete': sessionHistoryDeleteSchema,
    'terminal.output': terminalOutputSchema,
    'tool.event': toolEventSchema,
    'command.ack': commandAckSchema,
    'shortcut.catalog': shortcutCatalogSchema,
    'shortcut.run.update': shortcutRunUpdateSchema,
    'shortcut.run.input.ack': shortcutRunInputAckSchema,
    'file.preview.result': filePreviewResultSchema,
  });

  validate(input: unknown): ProtocolValidationResult {
    const result = this.schemas.validate(input);
    if (!result.ok) return result;
    const { message } = result;
    const { envelope } = message;

    if (envelope.type === 'ai.capabilities' || envelope.type === 'ai.update') {
      if (envelope.sessionId !== undefined || envelope.seq !== undefined || envelope.commandId !== undefined) return invalidContext(envelope,'AI messages must not include sessionId, seq or commandId.');
      if (message.type === 'ai.capabilities') {
        const providers = message.envelope.payload.providers;
        if (new Set(providers.map(p => p.provider)).size !== providers.length) return invalidContext(envelope,'AI providers must be unique.');
      }
    } else if (envelope.type === 'file.preview.result') {
      if (!envelope.sessionId || envelope.seq !== undefined || envelope.commandId !== undefined) {
        return invalidContext(envelope, 'file.preview.result requires sessionId and must not include seq or commandId.');
      }
    } else if (envelope.type === 'shortcut.catalog' || envelope.type === 'shortcut.run.update'
      || envelope.type === 'shortcut.run.input.ack') {
      if (envelope.sessionId !== undefined || envelope.seq !== undefined || envelope.commandId !== undefined) {
        return invalidContext(envelope, `${envelope.type} must not include sessionId, seq, or commandId.`);
      }
      if (message.type === 'shortcut.catalog') {
        const shortcuts = message.envelope.payload.shortcuts;
        if (new Set(shortcuts.map((shortcut) => shortcut.id.toLowerCase())).size !== shortcuts.length) {
          return invalidContext(envelope, 'shortcut.catalog contains duplicate IDs.');
        }
      }
    } else if (envelope.type === 'session.history.list') {
      if (envelope.sessionId !== undefined || envelope.seq !== undefined || envelope.commandId !== undefined) {
        return invalidContext(envelope, 'session.history.list must not include sessionId, seq, or commandId.');
      }
    } else if (envelope.type === 'session.history.request' || envelope.type === 'session.history.delete') {
      if (!envelope.sessionId || envelope.seq !== undefined || envelope.commandId !== undefined) {
        return invalidContext(envelope, `${envelope.type} requires sessionId and must not include seq or commandId.`);
      }
    } else if (envelope.type === 'session.started') {
      if (!envelope.sessionId || envelope.seq !== 0) {
        return invalidContext(
          envelope,
          'session.started requires sessionId and seq 0.',
        );
      }
    } else if (envelope.type === 'session.ended' || envelope.type === 'session.sync') {
      if (!envelope.sessionId || envelope.seq !== undefined) {
        return invalidContext(
          envelope,
          `${envelope.type} requires sessionId and must not include seq.`,
        );
      }
    } else if (envelope.type === 'terminal.output' || envelope.type === 'tool.event') {
      if (!envelope.sessionId || envelope.seq === undefined) {
        return invalidContext(
          envelope,
          `${envelope.type} requires sessionId and seq.`,
        );
      }
      if (message.type === 'tool.event') {
        const semanticError = validateToolEvent(message.envelope.payload);
        if (semanticError) return invalidContext(envelope, semanticError);
      }
    } else if (message.type === 'command.ack') {
      const payload = message.envelope.payload;
      if (!envelope.sessionId || !envelope.commandId || envelope.commandId !== payload.commandId) {
        return invalidContext(
          envelope,
          'command.ack requires sessionId and matching commandId.',
        );
      }
    }

    return result;
  }
}

function invalidContext(
  envelope: Envelope<unknown>,
  detail: string,
): ProtocolValidationResult {
  return {
    ok: false,
    code: 'invalid_message',
    detail,
    relatedMessageId: envelope.messageId,
  };
}

function validateToolEvent(payload: ToolEventPayload): string | undefined {
  const data = payload.data;
  const stringField = (name: string, required = true): boolean =>
    typeof data[name] === 'string' && (!required || (data[name] as string).length > 0);
  switch (payload.kind) {
    case 'turn.started':
      return stringField('turnId') ? undefined : 'tool.event turn.started requires data.turnId.';
    case 'user.message':
      return stringField('messageId') && stringField('text', false)
        ? undefined : 'tool.event user.message requires messageId and text.';
    case 'assistant.delta': case 'assistant.completed': case 'reasoning.delta': case 'plan.updated':
      return stringField('text', false) ? undefined : `tool.event ${payload.kind} requires data.text.`;
    case 'command.output':
      return stringField('commandId') && stringField('text', false)
        ? undefined : 'tool.event command.output requires commandId and text.';
    case 'command.started':
      return stringField('commandId') && stringField('command') ? undefined : 'tool.event command.started requires commandId and command.';
    case 'command.completed':
      return stringField('commandId') ? undefined : 'tool.event command.completed requires commandId.';
    case 'file.changed':
      return stringField('itemId') && stringField('summary') ? undefined : 'tool.event file.changed requires itemId and summary.';
    case 'approval.requested':
      return stringField('approvalId') && stringField('turnId') && stringField('kind')
        && ['low', 'medium', 'high', 'critical'].includes(String(data.risk))
        && stringField('title') && Array.isArray(data.availableDecisions)
        && data.availableDecisions.length > 0
        && data.availableDecisions.every((value) => ['allowOnce', 'allowSession', 'allowPolicy', 'deny', 'cancel'].includes(String(value)))
        && stringField('expiresAt') && !Number.isNaN(Date.parse(String(data.expiresAt)))
        ? undefined : 'tool.event approval.requested is incomplete.';
    case 'approval.resolved':
      return stringField('approvalId') && stringField('turnId') && ['allowOnce', 'allowSession', 'allowPolicy', 'deny', 'cancel'].includes(String(data.decision))
        ? undefined : 'tool.event approval.resolved is incomplete.';
    case 'user-input.requested': {
      const questions = data.questions;
      const validQuestions = Array.isArray(questions) && questions.length > 0 && questions.every((value) => {
        const question = asRecord(value);
        return question && typeof question.id === 'string' && question.id.length > 0
          && typeof question.header === 'string' && typeof question.question === 'string'
          && Array.isArray(question.options) && typeof question.allowsOther === 'boolean'
          && typeof question.isSecret === 'boolean';
      });
      return stringField('requestId') && stringField('turnId') && stringField('itemId')
        && typeof data.isBlocking === 'boolean' && validQuestions
        ? undefined : 'tool.event user-input.requested is incomplete.';
    }
    case 'user-input.resolved':
      return stringField('requestId') && stringField('turnId') && asRecord(data.answers)
        ? undefined : 'tool.event user-input.resolved is incomplete.';
    case 'turn.completed':
      return stringField('turnId') && ['completed', 'interrupted', 'failed'].includes(String(data.status))
        ? undefined : 'tool.event turn.completed requires turnId and a valid status.';
    case 'warning': case 'error':
      return stringField('code') && stringField('message') ? undefined : `tool.event ${payload.kind} requires code and message.`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
