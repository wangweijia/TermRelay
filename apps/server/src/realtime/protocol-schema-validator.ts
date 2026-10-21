import type { Envelope } from '@termrelay/contracts';
import { envelopeSchema } from '@termrelay/contracts';
import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

export type SchemaValidationResult<Message> =
  | { ok: true; message: Message }
  | {
      ok: false;
      code: 'invalid_message' | 'unsupported_version';
      detail: string;
      relatedMessageId?: string;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export class ProtocolSchemaValidator<
  Message extends { type: string; envelope: Envelope<unknown> },
> {
  private readonly envelopeValidator: ValidateFunction;
  private readonly payloadValidators: ReadonlyMap<string, ValidateFunction>;

  constructor(
    private readonly source: 'client' | 'browser',
    schemas: Record<Message['type'], AnySchema>,
  ) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    ajv.addFormat('uuid', UUID_PATTERN);
    ajv.addFormat('date-time', (value: string) =>
      ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value)));
    this.envelopeValidator = ajv.compile(envelopeSchema);
    this.payloadValidators = new Map(
      Object.entries<AnySchema>(schemas).map(([type, schema]) => [type, ajv.compile(schema)]),
    );
  }

  validate(input: unknown): SchemaValidationResult<Message> {
    const record = typeof input === 'object' && input !== null
      ? input as Record<string, unknown> : undefined;
    const relatedMessageId = typeof record?.messageId === 'string' && UUID_PATTERN.test(record.messageId)
      ? record.messageId : undefined;
    if (record && record.protocolVersion !== undefined && record.protocolVersion !== '2') {
      return {
        ok: false,
        code: 'unsupported_version',
        detail: 'Only protocol version 2 is supported.',
        ...(relatedMessageId ? { relatedMessageId } : {}),
      };
    }
    if (!this.envelopeValidator(input)) {
      return invalid(formatErrors(this.envelopeValidator.errors), relatedMessageId);
    }

    const envelope = input as Envelope<unknown>;
    const payloadValidator = this.payloadValidators.get(envelope.type);
    if (!payloadValidator) {
      return invalid(`Unsupported ${this.source} message type: ${envelope.type}`, envelope.messageId);
    }
    if (!payloadValidator(envelope.payload)) {
      return invalid(`${envelope.type} payload: ${formatErrors(payloadValidator.errors)}`, envelope.messageId);
    }
    // Both the envelope and its type-specific payload have passed their schemas.
    return { ok: true, message: { type: envelope.type, envelope } as Message };
  }
}

function invalid(detail: string, relatedMessageId?: string): SchemaValidationResult<never> {
  return {
    ok: false,
    code: 'invalid_message',
    detail,
    ...(relatedMessageId ? { relatedMessageId } : {}),
  };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'Schema validation failed.';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
    .slice(0, 1_500);
}
