import { Injectable } from '@nestjs/common';
import type {
  Envelope,
  SessionSubscribePayload,
  SessionUnsubscribePayload,
  SessionInterruptPayload,
  SessionStopPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  ToolApprovalResolvePayload,
  ToolTurnInterruptPayload,
  ToolTurnStartPayload,
  ToolUserInputResolvePayload,
} from '@termrelay/contracts';
import {
  toolConfigSetSchema,
  sessionInterruptSchema,
  sessionStopSchema,
  sessionSubscribeSchema,
  sessionUnsubscribeSchema,
  terminalInputSchema,
  terminalResizeSchema,
  toolApprovalResolveSchema,
  toolTurnInterruptSchema,
  toolTurnStartSchema,
  toolUserInputResolveSchema,
} from '@termrelay/contracts';
import { ProtocolSchemaValidator, type SchemaValidationResult } from './protocol-schema-validator';

export type ValidBrowserMessage =
  | { type: 'session.subscribe'; envelope: Envelope<SessionSubscribePayload> }
  | {
      type: 'session.unsubscribe';
      envelope: Envelope<SessionUnsubscribePayload>;
    }
  | { type: 'terminal.input'; envelope: Envelope<TerminalInputPayload> }
  | { type: 'terminal.resize'; envelope: Envelope<TerminalResizePayload> }
  | { type: 'session.interrupt'; envelope: Envelope<SessionInterruptPayload> }
  | { type: 'session.stop'; envelope: Envelope<SessionStopPayload> }
  | { type: 'tool.turn.start'; envelope: Envelope<ToolTurnStartPayload> }
  | { type: 'tool.config.set'; envelope: Envelope<{ id: 'model' | 'effort'; value: string }> }
  | { type: 'tool.turn.interrupt'; envelope: Envelope<ToolTurnInterruptPayload> }
  | { type: 'tool.approval.resolve'; envelope: Envelope<ToolApprovalResolvePayload> }
  | { type: 'tool.user-input.resolve'; envelope: Envelope<ToolUserInputResolvePayload> };

export type BrowserValidationResult = SchemaValidationResult<ValidBrowserMessage>;

@Injectable()
export class BrowserProtocolValidator {
  private readonly schemas = new ProtocolSchemaValidator<ValidBrowserMessage>('browser', {
    'session.subscribe': sessionSubscribeSchema,
    'session.unsubscribe': sessionUnsubscribeSchema,
    'terminal.input': terminalInputSchema,
    'terminal.resize': terminalResizeSchema,
    'session.interrupt': sessionInterruptSchema,
    'session.stop': sessionStopSchema,
    'tool.turn.start': toolTurnStartSchema,
    'tool.config.set': toolConfigSetSchema,
    'tool.turn.interrupt': toolTurnInterruptSchema,
    'tool.approval.resolve': toolApprovalResolveSchema,
    'tool.user-input.resolve': toolUserInputResolveSchema,
  });

  validate(input: unknown): BrowserValidationResult {
    const result = this.schemas.validate(input);
    if (!result.ok) return result;
    const { type, envelope } = result.message;
    if (!envelope.sessionId) {
      return invalid(`${envelope.type} requires sessionId.`, envelope.messageId);
    }

    if (type !== 'session.subscribe' && type !== 'session.unsubscribe' && !envelope.commandId) {
      return invalid(`${envelope.type} requires commandId.`, envelope.messageId);
    }

    return result;
  }
}

function invalid(
  detail: string,
  relatedMessageId?: string,
): BrowserValidationResult {
  return {
    ok: false,
    code: 'invalid_message',
    detail,
    ...(relatedMessageId ? { relatedMessageId } : {}),
  };
}
