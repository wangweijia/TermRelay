import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const schema = JSON.parse(await readFile(new URL('ai.schema.json', root), 'utf8'));
for (const name of ['AiJobRequest','AiConversationRequest','AiTurnRequest']) {
  const { $schema, $id, $defs, ...definition } = JSON.parse(await readFile(new URL(`ai-${name}.schema.json`,root),'utf8'));
  schema.$defs[name] = definition;
}
function ts(s) {
  if (s.$ref) return s.$ref.split('/').at(-1);
  if (s.enum) return s.enum.map(JSON.stringify).join(' | ');
  if (s.type === 'array') return `Array<${ts(s.items)}>`;
  if (s.type === 'object' && s.properties) return `{ ${Object.entries(s.properties).map(([k,v]) => `${k}${s.required?.includes(k) ? '' : '?'}: ${ts(v)}`).join('; ')} }`;
  return ({string:'string',integer:'number',boolean:'boolean',object:'Record<string, unknown>'})[s.type] ?? 'unknown';
}
function swift(s) {
  if (s.$ref) return s.$ref.split('/').at(-1);
  if (s.type === 'array') return `[${swift(s.items)}]`;
  return ({string:'String',integer:'Int',boolean:'Bool',object:'[String: JSONValue]'})[s.type] ?? 'String';
}
let types = '// Generated from ai.schema.json. Do not edit.\n';
let sw = '// Generated from ai.schema.json. Do not edit.\nimport Foundation\n\n';
for (const [name, s] of Object.entries(schema.$defs)) {
  types += `export type ${name} = ${ts(s)};\n`;
  types += `export const ${name[0].toLowerCase()+name.slice(1)}Schema = ${JSON.stringify({ ...schema, $id:schema.$id.replace('.schema.json',`-${name}.schema.json`), $ref:'#/$defs/'+name })} as const;\n`;
  const fields = Object.entries(s.properties);
  sw += `struct ${name}: Codable, Sendable {\n`;
  for (const [k,v] of fields) sw += `    let ${k}: ${swift(v)}${s.required?.includes(k) ? '' : '?'}\n`;
  sw += `    init(${fields.map(([k,v])=>`${k}: ${swift(v)}${s.required?.includes(k) ? '' : '? = nil'}`).join(', ')}) {\n`;
  for (const [k] of fields) sw += `        self.${k} = ${k}\n`;
  sw += '    }\n}\n\n';
}
await writeFile(new URL('generated/typescript/ai.ts',root),types);
await writeFile(new URL('generated/swift/AIService.swift',root),sw);
await mkdir(new URL('../../apps/mac/Sources/Generated/',root), {recursive:true});
await writeFile(new URL('../../apps/mac/Sources/Generated/AIService.swift',root),sw);
