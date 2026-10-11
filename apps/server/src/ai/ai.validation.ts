import { BadRequestException } from '@nestjs/common';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { aiJobRequestSchema, aiConversationRequestSchema, aiTurnRequestSchema } from '@termrelay/contracts';
import { createHash } from 'node:crypto';

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const validators = { job: ajv.compile(aiJobRequestSchema), conversation: ajv.compile(aiConversationRequestSchema), turn: ajv.compile(aiTurnRequestSchema) };
export function validateRequest(kind: keyof typeof validators, body: unknown): void {
  if (Buffer.byteLength(JSON.stringify(body) ?? '') > 262144 || !validators[kind](body)) throw new BadRequestException('invalid_request');
  const b = body as Record<string, unknown>;
  const target = b.target as { deviceId?: string } | undefined;
  if (target && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.deviceId ?? '')) throw new BadRequestException('invalid_device_id');
  function bounded(v: unknown, depth: number): void {
    if (depth > 32) throw new BadRequestException('input_too_deep');
    if (v && typeof v === 'object') for (const value of Object.values(v)) bounded(value,depth+1);
  }
  bounded(body,0);
  const input = b.input as { instructions?: string; facts?: object } | undefined;
  if (kind !== 'conversation' && !input?.instructions?.trim() && !Object.keys(input?.facts ?? {}).length) throw new BadRequestException('empty_input');
  const schema = (b.output as { schema?: Record<string,unknown> } | undefined)?.schema;
  if (schema) compileOutput(schema);
}

export function compileOutput(schema: Record<string,unknown>): ValidateFunction {
  if (Buffer.byteLength(JSON.stringify(schema)) > 32768) throw new BadRequestException('schema_too_large');
  let nodes = 0;
  function walk(v: unknown, depth: number): void {
    if (++nodes > 2000 || depth > 16) throw new BadRequestException('schema_too_complex');
    if (typeof v !== 'object' || v === null) return;
    for (const [key,value] of Object.entries(v)) {
      // A bounded subset avoids untrusted regular expressions and remote references.
      if (['$ref','$dynamicRef','pattern','patternProperties','format'].includes(key)) throw new BadRequestException('unsupported_schema_keyword');
      walk(value, depth + 1);
    }
  }
  walk(schema, 0);
  try { return new Ajv2020({ strict: false, validateFormats: false, allErrors: false }).compile(schema); }
  catch { throw new BadRequestException('invalid_schema'); }
}

export function fingerprint(value: unknown): string {
  function ordered(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(ordered);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,ordered(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

export function extractResult(text: string, output: import('@termrelay/contracts').AiOutput): unknown {
  if (Buffer.byteLength(text) > 262144) throw new Error('output_too_large');
  if (output.kind === 'text') return text;
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  let result: unknown;
  try { result = JSON.parse(match?.[1] ?? trimmed); } catch { throw new Error('invalid_json'); }
  if (output.schema && !compileOutput(output.schema)(result)) throw new Error('schema_mismatch');
  return result;
}
