import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020';
import {
  envelopeSchema, toolEventSchema, toolTurnStartSchema, toolTurnInterruptSchema,
  toolApprovalResolveSchema, toolUserInputResolveSchema, toolConfigSetSchema,
  terminalInputSchema, terminalResizeSchema,
} from '@termrelay/contracts';
import { record, UUID, type JsonObject } from './util.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat('uuid', UUID);
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const envelope = ajv.compile(envelopeSchema);
const event = ajv.compile(toolEventSchema);
const commands = new Map<string, ValidateFunction>(Object.entries({
  'tool.turn.start': toolTurnStartSchema, 'tool.turn.interrupt': toolTurnInterruptSchema,
  'tool.approval.resolve': toolApprovalResolveSchema, 'tool.user-input.resolve': toolUserInputResolveSchema,
  'tool.config.set': toolConfigSetSchema, 'terminal.input': terminalInputSchema, 'terminal.resize': terminalResizeSchema,
  'session.interrupt': { type: 'object', maxProperties: 0 },
  'session.stop': { type: 'object', maxProperties: 0 },
}).map(([key, schema]) => [key, ajv.compile(schema as AnySchema)]));

export function validateEnvelope(value: unknown): JsonObject {
  if (!envelope(value)) throw new Error('Invalid Server envelope');
  return record(value);
}
export function validateCommand(kind: string, payload: unknown): JsonObject {
  const validate = commands.get(kind);
  if (!validate || !validate(payload)) throw new Error('Unsupported command or invalid payload');
  return record(payload);
}
export function validateToolEvent(payload: unknown): void {
  if (!event(payload)) throw new Error(`Invalid tool event: ${ajv.errorsText(event.errors)}`);
}
