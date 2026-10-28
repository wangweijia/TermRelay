import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.local', 'node_modules'].includes(entry.name)) continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await check(url);
    else if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
await check(root);
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root)));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 is required.');
for (const path of [manifest.background.service_worker, manifest.options_page, ...manifest.content_scripts.flatMap(item => item.js)]) {
  await readFile(new URL(`extension/${path}`, root));
}
console.log('JavaScript syntax and unpacked extension entrypoints are valid.');
