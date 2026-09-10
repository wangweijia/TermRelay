import { Injectable } from '@nestjs/common';
import type {
  DeviceHeartbeatPayload,
  DeviceRegisterPayload,
  Envelope,
} from '@termrelay/contracts';
import {
  deviceHeartbeatSchema,
  deviceRegisterSchema,
  envelopeSchema,
} from '@termrelay/contracts';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

export type ValidClientMessage =
  | { type: 'device.register'; envelope: Envelope<DeviceRegisterPayload> }
  | { type: 'device.heartbeat'; envelope: Envelope<DeviceHeartbeatPayload> };

export type ProtocolValidationResult =
  | { ok: true; message: ValidClientMessage }
  | {
      ok: false;
      code: 'invalid_message' | 'unsupported_version';
      detail: string;
      relatedMessageId?: string;
    };

@Injectable()
export class ProtocolValidator {
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
      ['device.register', ajv.compile(deviceRegisterSchema)],
      ['device.heartbeat', ajv.compile(deviceHeartbeatSchema)],
    ]);
  }

  validate(input: unknown): ProtocolValidationResult {
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
      return {
        ok: false,
        code: 'invalid_message',
        detail: formatErrors(this.envelopeValidator.errors),
        ...(relatedMessageId ? { relatedMessageId } : {}),
      };
    }

    const envelope = input as Envelope;
    const payloadValidator = this.payloadValidators.get(envelope.type);
    if (!payloadValidator) {
      return {
        ok: false,
        code: 'invalid_message',
        detail: `Unsupported client message type: ${envelope.type}`,
        relatedMessageId: envelope.messageId,
      };
    }

    if (!payloadValidator(envelope.payload)) {
      return {
        ok: false,
        code: 'invalid_message',
        detail: `${envelope.type} payload: ${formatErrors(payloadValidator.errors)}`,
        relatedMessageId: envelope.messageId,
      };
    }

    if (envelope.type === 'device.register') {
      return {
        ok: true,
        message: {
          type: envelope.type,
          envelope: envelope as unknown as Envelope<DeviceRegisterPayload>,
        },
      };
    }

    return {
      ok: true,
      message: {
        type: 'device.heartbeat',
        envelope: envelope as unknown as Envelope<DeviceHeartbeatPayload>,
      },
    };
  }
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'Schema validation failed.';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
    .slice(0, 1_500);
}
