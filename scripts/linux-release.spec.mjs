import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function fixture(t) {
  const parent = fileURLToPath(new URL('dist/', root));
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'linux-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const path of ['bin', 'scripts', 'apps/linux/packaging', 'apps/linux/dist/src', 'packages/contracts/dist', 'unrelated']) {
    await mkdir(join(directory, path), { recursive: true });
  }
  for (const name of ['build-linux-release.sh', 'stage-linux-release.cjs', 'smoke-linux-release.cjs']) {
    await copyFile(new URL(`scripts/${name}`, root), join(directory, 'scripts', name));
  }
  for (const name of ['termrelay-linux', 'termrelay-agent.service']) {
    await copyFile(new URL(`apps/linux/packaging/${name}`, root), join(directory, 'apps/linux/packaging', name));
  }
  for (const path of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    await copyFile(new URL(path, root), join(directory, path));
  }
  await writeFile(join(directory, 'apps/linux/package.json'), '{"name":"@termrelay/linux","version":"0.2.3"}');
  await writeFile(join(directory, 'packages/contracts/package.json'), '{"name":"@termrelay/contracts"}');
  await writeFile(join(directory, 'packages/contracts/dist/index.js'), 'module.exports = {};');
  await writeFile(join(directory, 'apps/linux/dist/src/cli.js'), "console.log('0.2.3');");
  await writeFile(join(directory, 'apps/linux/dist/src/pty.js'), `
module.exports.TerminalRuntime = class {
  constructor(_root, emit) { this.emit = emit; }
  async command() { this.emit({ kind: 'output', data: Buffer.from('中文\\r\\nSTAGED_OK\\r\\n') }); }
  async close() {}
};
`);
  const log = join(directory, 'commands.jsonl');
  const license = join(directory, 'LICENSE');
  await writeFile(license, 'Test fixture license');
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = { command, args, cwd: process.cwd() };
if (command === 'dpkg-deb') {
  const stage = args[2];
  record.control = fs.readFileSync(path.join(stage, 'DEBIAN/control'), 'utf8');
  record.unit = fs.readFileSync(path.join(stage, 'usr/lib/systemd/user/termrelay-agent.service'), 'utf8');
  record.launchersMatch = fs.readFileSync(path.join(stage, 'usr/bin/termrelay-agent'), 'utf8') ===
    fs.readFileSync(path.join(stage, 'usr/bin/termrelay-linux'), 'utf8');
  fs.writeFileSync(args.at(-1), 'fixture deb');
}
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(record) + '\\n');
if (command === 'uname') console.log(process.env.MOCK_OS || 'Linux');
if (command === 'dpkg') console.log('amd64');
if (command === 'ldd') console.log(process.env.MOCK_BAD_NODE ? 'libnode.so => /lib/libnode.so' : 'libc.so.6 => /lib/libc.so.6');
if (command === 'pnpm' && args.includes('deploy')) {
  const output = args.at(-1);
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'apps/linux/dist'), path.join(output, 'dist'), { recursive: true });
}
if (command === 'node') {
  if (args[0] === '-p') {
    console.log(args[1] === 'process.arch' ? process.env.MOCK_NODE_ARCH || 'x64' :
      JSON.parse(fs.readFileSync('apps/linux/package.json', 'utf8')).version);
  } else {
    if (!fs.existsSync(args[0])) throw new Error('Release staging helper missing');
    const runtime = path.join(args[1], 'runtime/bin');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'node'), '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });
  }
}
`;
  for (const command of ['uname', 'dpkg', 'ldd', 'pnpm', 'node', 'dpkg-deb']) {
    const path = join(directory, 'bin', command);
    await writeFile(path, mock);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    MOCK_LOG: log, TERMRELAY_NODE_LICENSE: license,
  };
  delete env.NODE_TEST_CONTEXT;
  return {
    directory, env,
    async commands() {
      return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    },
  };
}

function build(f, overrides = {}) {
  return spawnSync('bash', [join(f.directory, 'scripts/build-linux-release.sh')], {
    cwd: join(f.directory, 'unrelated'), env: { ...f.env, ...overrides }, encoding: 'utf8', timeout: 30_000,
  });
}

test('Linux release resolves repository paths independently of cwd and separates release artifacts', async t => {
  const f = await fixture(t);
  const result = build(f);
  assert.equal(result.status, 0, result.stderr);
  const commands = await f.commands();
  assert.deepEqual(commands.find(c => c.command === 'pnpm')?.args, ['--filter', '@termrelay/linux', 'build']);
  assert.equal(commands.find(c => c.command === 'pnpm')?.cwd, f.directory);
  assert.equal(commands.find(c => c.command === 'node' && c.args[0] !== '-p')?.args[0],
    join(f.directory, 'scripts/stage-linux-release.cjs'));
  const packed = commands.find(c => c.command === 'dpkg-deb');
  assert.equal(packed?.args.at(-1), join(f.directory, 'dist/termrelay-linux/termrelay-linux_0.2.3_amd64.deb'));
  assert.match(packed.control, /Architecture: amd64/);
  assert.match(packed.unit, /\/usr\/bin\/termrelay-agent/);
  assert.equal(packed.launchersMatch, true);
  assert.equal(await readFile(packed.args.at(-1), 'utf8'), 'fixture deb');
  await assert.rejects(stat(join(f.directory, 'apps/linux/dist/termrelay-linux_0.2.3_amd64.deb')), { code: 'ENOENT' });
});

test('Linux release preserves host, architecture and private-runtime dependency guards', async t => {
  const f = await fixture(t);
  for (const [overrides, message] of [
    [{ MOCK_OS: 'Darwin' }, /matching Linux architecture/],
    [{ MOCK_NODE_ARCH: 'arm64' }, /host and Node architecture must match/],
    [{ MOCK_BAD_NODE: '1' }, /official Node distribution/],
  ]) {
    const result = build(f, overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
  assert.equal((await f.commands()).some(c => c.command === 'dpkg-deb'), false);
});

test('relocated staging and smoke helpers run with private Node and no system runtime on PATH', async t => {
  const f = await fixture(t);
  const output = join(f.directory, 'staged-release');
  const result = spawnSync(process.execPath, [join(f.directory, 'scripts/stage-linux-release.cjs'), output], {
    cwd: join(f.directory, 'unrelated'), env: f.env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Private-runtime PTY smoke passed/);
  const manifest = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  assert.deepEqual(manifest, { version: '0.2.3', node: process.version, platform: process.platform, arch: process.arch });
  assert.equal(await readFile(join(output, 'runtime/LICENSE'), 'utf8'), 'Test fixture license');
  const commands = await f.commands();
  const deploy = commands.find(c => c.command === 'pnpm');
  assert.deepEqual(deploy.args, ['--filter', '@termrelay/linux', 'deploy', '--legacy', '--prod', join(output, 'app')]);
  assert.notEqual(deploy.cwd, f.directory);
  await assert.rejects(stat(deploy.cwd), { code: 'ENOENT' });
});

test('platform release commands, packaging artwork and package-local tools have explicit owners', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  for (const platform of ['mac', 'linux', 'server']) {
    const script = `scripts/build-${platform}-release.sh`;
    assert.equal(manifest.scripts[`release:${platform}`], `bash ${script}`);
    assert.equal((await stat(new URL(script, root))).isFile(), true);
  }
  assert.equal(manifest.scripts['linux:deb'], 'pnpm release:linux');
  const icon = 'apps/mac/packaging/AppIcon/TermRelay-AppIcon-1024.png';
  assert.equal((await stat(new URL(icon, root))).isFile(), true);
  const macScript = await readFile(new URL('scripts/build-mac-release.sh', root), 'utf8');
  assert.match(macScript, /\$package_dir\/packaging\/AppIcon\/TermRelay-AppIcon-1024\.png/);
  const contracts = JSON.parse(await readFile(new URL('packages/contracts/package.json', root), 'utf8'));
  assert.match(contracts.scripts.build, /node scripts\/generate-config-schemas\.mjs/);
  for (const path of [
    'packages/contracts/scripts/generate-config-schemas.mjs',
    'packages/contracts/scripts/generate-ai.mjs',
    'apps/linux/scripts/build-native.cjs',
    'scripts/linux-remote-start.cjs',
    'scripts/validate-linux-events.cjs',
  ]) assert.equal((await stat(new URL(path, root))).isFile(), true);
});
