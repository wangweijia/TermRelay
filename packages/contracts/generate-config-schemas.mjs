import { readFile, writeFile } from 'node:fs/promises';

const indexURL = new URL('./generated/typescript/index.ts', import.meta.url);
let source = await readFile(indexURL, 'utf8');
for (const [name, path, next] of [
  ['toolEventSchema', './events/tool-event.schema.json', 'toolTurnStartSchema'],
  ['toolConfigSetSchema', './commands/tool-config-set.schema.json', 'toolTurnStartSchema'],
]) {
  const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const declaration = `export const ${name} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
  const start = source.indexOf(`export const ${name} = `);
  const end = source.indexOf(`export const ${next} = `);
  if (end < 0 || (start >= 0 && start > end)) throw new Error(`Missing ${next} export`);
  if (start >= 0) {
    source = source.slice(0, start) + declaration + source.slice(end);
  } else {
    source = source.slice(0, end) + declaration + source.slice(end);
  }
}
await writeFile(indexURL, source);