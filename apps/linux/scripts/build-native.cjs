const { mkdirSync, existsSync, chmodSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, dirname } = require('node:path');

mkdirSync('dist', { recursive: true });
const result = spawnSync(process.env.CC || 'cc', [
  '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  'native/supervisor.c', '-o', join('dist', 'termrelay-supervisor'),
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.platform === 'darwin') {
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const path of [join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'), join(root, 'build/Release/spawn-helper')]) {
    if (existsSync(path)) chmodSync(path, 0o755);
  }
}
