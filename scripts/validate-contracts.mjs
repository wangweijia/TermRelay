import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../packages/contracts/', import.meta.url);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'generated') files.push(...await collect(path));
    if (entry.isFile() && entry.name.endsWith('.schema.json')) files.push(path);
  }
  return files;
}

const files = await collect(root.pathname);
if (files.length === 0) throw new Error('No contract schemas found');

const ids = new Set();
for (const file of files) {
  const schema = JSON.parse(await readFile(file, 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`${file}: expected JSON Schema draft 2020-12`);
  }
  if (!schema.$id) throw new Error(`${file}: missing $id`);
  if (ids.has(schema.$id)) throw new Error(`${file}: duplicate $id ${schema.$id}`);
  ids.add(schema.$id);
}

console.log(`Validated ${files.length} contract schemas.`);
