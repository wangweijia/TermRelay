import { Injectable } from '@nestjs/common';
import type {
  Envelope,
  SessionSubscribePayload,
  SessionUnsubscribePayload,
} from '@termrelay/contracts';
import {
  envelopeSchema,
  sessionSubscribeSchema,
  sessionUnsubscribeSchema,
} from '@termrelay/contracts';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

export type ValidBrowserMessage =
  | { type: 'session.subscribe'; envelope: Envelope<SessionSubscribePayload> }
  | {
      type: 'session.unsubscribe';
      envelope: Envelope<SessionUnsubscribePayload>;
    };

export type BrowserValidationResult =
  | { ok: true; message: ValidBrowserMessage }
  | {
      ok: false;
      code: 'invalid_message' | 'unsupported_version';
      detail: string;
      relatedMessageId?: string;
    };

@Injectable()
export class BrowserProtocolValidator {
  private readonly envelopeValidator: ValidateFunction;
  private readonly payloadValidators: ReadonlyMap<string, ValidateFunction>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addFormat('uuid', UUID_PATTERN);
    ajv.addFormat('date-time', (value: string) => {
      return ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
    });
    this.envelopeValidator = ajv.compile(envelopeSchema);
    this.payloadValidators = new Map([
      ['session.subscribe', ajv.compile(sessionSubscribeSchema)],
      ['session.unsubscribe', ajv.compile(sessionUnsubscribeSchema)],
    ]);
  }

  validate(input: unknown): BrowserValidationResult {
    const record = asRecord(input);
    const relatedMessageId = readUuid(record?.messageId);
    if (record && record.protocolVersion !== undefined && record.protocolVersion !== '1') {
      return {
        ok: false,
        code: 'unsupported_version',
        detail: 'Only protocol version 1 is supported.',
        ...(relatedMessageId ? { relatedMessageId } : {}),
      };
    }

    if (!this.envelopeValidator(input)) {
      return invalid(formatErrors(this.envelopeValidator.errors), relatedMessageId);
    }

    const envelope = input as Envelope;
    const payloadValidator = this.payloadValidators.get(envelope.type);
    if (!payloadValidator) {
      return invalid(
        `Unsupported browser message type: ${envelope.type}`,
        envelope.messageId,
      );
    }
    if (!payloadValidator(envelope.payload)) {
      return invalid(
        `${envelope.type} payload: ${formatErrors(payloadValidator.errors)}`,
        envelope.messageId,
      );
    }
    if (!envelope.sessionId) {
      return invalid(`${envelope.type} requires sessionId.`, envelope.messageId);
    }

    return envelope.type === 'session.subscribe'
      ? {
          ok: true,
          message: {
            type: envelope.type,
            envelope: envelope as unknown as Envelope<SessionSubscribePayload>,
          },
        }
      : {
          ok: true,
          message: {
            type: 'session.unsubscribe',
            envelope: envelope as unknown as Envelope<SessionUnsubscribePayload>,
          },
        };
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value
    : undefined;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'Schema validation failed.';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
    .slice(0, 1_500);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
