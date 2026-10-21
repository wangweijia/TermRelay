const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

function stageRelease(destination) {
  const root = resolve(__dirname, '..', '..', '..');
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('Release destination must not already exist');
  const node = process.execPath;
  const license = process.env.TERMRELAY_NODE_LICENSE || join(dirname(node), '..', 'LICENSE');
  if (!existsSync(license)) throw new Error('Node runtime LICENSE missing; set TERMRELAY_NODE_LICENSE to the matching distribution LICENSE');
  mkdirSync(output, { recursive: true });
  execFileSync('pnpm', ['--filter', '@termrelay/linux', 'deploy', '--legacy', '--prod', join(output, 'app')], {
    cwd: root, stdio: 'inherit',
  });
  mkdirSync(join(output, 'runtime', 'bin'), { recursive: true });
  cpSync(node, join(output, 'runtime', 'bin', 'node'));
  cpSync(license, join(output, 'runtime', 'LICENSE'));
  const pkg = JSON.parse(readFileSync(join(root, 'apps/linux/package.json'), 'utf8'));
  writeFileSync(join(output, 'release.json'), JSON.stringify({
    version: pkg.version, node: process.version, platform: process.platform, arch: process.arch,
  }, null, 2));
  execFileSync(join(output, 'runtime/bin/node'), [join(output, 'app/dist/src/cli.js'), '--version'], { cwd: output, stdio: 'inherit' });
}

module.exports = { stageRelease };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: stage-release.cjs NEW_OUTPUT_DIRECTORY');
  stageRelease(process.argv[2]);
}
