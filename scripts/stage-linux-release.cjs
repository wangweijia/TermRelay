const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');

function stageRelease(destination) {
  const root = resolve(__dirname, '..');
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('Release destination must not already exist');
  const node = process.execPath;
  const license = process.env.TERMRELAY_NODE_LICENSE || join(dirname(node), '..', 'LICENSE');
  if (!existsSync(license)) throw new Error('Node runtime LICENSE missing; set TERMRELAY_NODE_LICENSE to the matching distribution LICENSE');
  mkdirSync(output, { recursive: true });
  // pnpm's production deploy settings must not alter the developer workspace's install state.
  const workspace = mkdtempSync(join(tmpdir(), 'termrelay-deploy-'));
  try {
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) cpSync(join(root, file), join(workspace, file));
    for (const project of ['apps/linux', 'packages/contracts']) {
      mkdirSync(join(workspace, project), { recursive: true });
      cpSync(join(root, project, 'package.json'), join(workspace, project, 'package.json'));
      cpSync(join(root, project, 'dist'), join(workspace, project, 'dist'), { recursive: true });
    }
    execFileSync('pnpm', ['--filter', '@termrelay/linux', 'deploy', '--legacy', '--prod', join(output, 'app')], {
      cwd: workspace, stdio: 'inherit',
    });
  } finally { rmSync(workspace, { recursive: true }); }
  for (const path of [
    join(output, 'app/node_modules/node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(output, 'app/node_modules/node-pty/build/Release/spawn-helper'),
  ]) {
    if (existsSync(path)) chmodSync(path, 0o755);
  }
  mkdirSync(join(output, 'runtime', 'bin'), { recursive: true });
  cpSync(node, join(output, 'runtime', 'bin', 'node'));
  cpSync(license, join(output, 'runtime', 'LICENSE'));
  const pkg = JSON.parse(readFileSync(join(root, 'apps/linux/package.json'), 'utf8'));
  writeFileSync(join(output, 'release.json'), JSON.stringify({
    version: pkg.version, node: process.version, platform: process.platform, arch: process.arch,
  }, null, 2));
  execFileSync(join(output, 'runtime/bin/node'), [join(output, 'app/dist/src/cli.js'), '--version'], { cwd: output, stdio: 'inherit' });
  execFileSync(join(output, 'runtime/bin/node'), [join(__dirname, 'smoke-linux-release.cjs'), output], {
    cwd: output, stdio: 'inherit', env: { ...process.env, PATH: '/nonexistent' }, timeout: 15000,
  });
}

module.exports = { stageRelease };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: stage-linux-release.cjs NEW_OUTPUT_DIRECTORY');
  stageRelease(process.argv[2]);
}
