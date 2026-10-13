import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const imageId = `sha256:${'a'.repeat(64)}`;

async function fixture(t) {
  const parent = new URL('../dist/', import.meta.url);
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent.pathname, 'release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const log = join(directory, 'commands.jsonl');
  const state = join(directory, 'image-id');
  const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'git') {
  if (args.includes('status')) process.exit(0);
  console.log(args.includes('--short') ? 'abc123' : '${'a'.repeat(40)}');
}
if (command === 'docker') {
  if (args[0] === 'buildx' && args[1] === 'build' && process.env.MOCK_BUILD_FAIL) process.exit(1);
  if (args[0] === 'save') fs.writeFileSync(args[args.indexOf('--output') + 1], 'mock Docker image');
  if (args[0] === 'load') fs.writeFileSync(process.env.MOCK_STATE, process.env.MOCK_LOADED_ID || '${imageId}');
  if (args[0] === 'image' && args[1] === 'inspect') {
    const id = fs.existsSync(process.env.MOCK_STATE)
      ? fs.readFileSync(process.env.MOCK_STATE, 'utf8')
      : process.env.MOCK_EXISTING_ID;
    if (!id) process.exit(1);
    console.log(id);
  }
}
`;
  for (const command of ['git', 'docker', 'pnpm', 'curl']) {
    const path = join(bin, command);
    await writeFile(path, mock);
    await chmod(path, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_LOG: log,
    MOCK_STATE: state,
    MOCK_EXISTING_ID: imageId,
  };
  delete env.NODE_TEST_CONTEXT;
  return {
    directory,
    env,
    async commands() {
      return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    },
  };
}

function run(script, args, env) {
  return spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

async function buildFixture(t) {
  const f = await fixture(t);
  for (const directory of ['scripts', 'deploy/server', 'apps/web/tests']) {
    await mkdir(join(f.directory, directory), { recursive: true });
  }
  await copyFile(new URL('scripts/build-server-release.sh', root), join(f.directory, 'scripts/build-server-release.sh'));
  for (const file of ['compose.release.yaml', 'release.env.example', 'deploy-release.sh']) {
    await copyFile(new URL(`deploy/server/${file}`, root), join(f.directory, `deploy/server/${file}`));
  }
  await writeFile(join(f.directory, 'apps/web/tests/release.test.mjs'), "import test from 'node:test'; test('Web checks ran', () => {});\n");
  f.script = join(f.directory, 'scripts/build-server-release.sh');
  f.output = join(f.directory, 'artifacts');
  await mkdir(f.output);
  return f;
}

async function deployFixture(t, { legacy = false } = {}) {
  const f = await fixture(t);
  f.script = join(f.directory, 'deploy.sh');
  await copyFile(new URL('deploy/server/deploy-release.sh', root), f.script);
  await copyFile(new URL('deploy/server/compose.release.yaml', root), join(f.directory, 'compose.yaml'));
  await writeFile(join(f.directory, 'manifest.env'),
    `TERMRELAY_IMAGE=termrelay/server:test\n${legacy ? '' : `TERMRELAY_IMAGE_ID=${imageId}\n`}`);
  await writeFile(join(f.directory, legacy ? 'image.tar.gz' : 'image.tar'), 'mock image');
  await writeFile(join(f.directory, '.env.production'), 'PUBLIC_ORIGIN=https://termrelay.example.com\n');
  return f;
}

test('release uses scoped checks and a single compressed archive with raw image and checksum', async t => {
  const f = await buildFixture(t);
  const oldArchive = join(f.output, 'termrelay-server-old-linux-arm64.tar.gz');
  await writeFile(oldArchive, 'previous release');
  await writeFile(`${oldArchive}.sha256`, 'previous checksum');
  const result = run(f.script, ['--version', 'test', '--output-dir', f.output], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Web checks ran/);
  const commands = await f.commands();
  assert.deepEqual(commands.filter(c => c.command === 'pnpm').map(c => c.args), [
    ['contracts:check'], ['--filter', '@termrelay/server', 'test'],
  ]);
  const archive = join(f.output, 'termrelay-server-test-linux-arm64.tar.gz');
  const entries = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  assert.match(entries.stdout, /\/image\.tar\n/);
  assert.doesNotMatch(entries.stdout, /image\.tar\.gz/);
  const extracted = join(f.directory, 'extracted');
  await mkdir(extracted);
  const extraction = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
  assert.equal(extraction.status, 0, extraction.stderr);
  const payload = join(extracted, 'termrelay-server-test');
  assert.equal(await readFile(join(payload, 'image.tar'), 'utf8'), 'mock Docker image');
  assert.match(await readFile(join(payload, 'manifest.env'), 'utf8'), new RegExp(`TERMRELAY_IMAGE_ID=${imageId}`));
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${checksum}  termrelay-server-test-linux-arm64.tar.gz\n`);
  await assert.rejects(readFile(oldArchive), { code: 'ENOENT' });
  await assert.rejects(readFile(`${oldArchive}.sha256`), { code: 'ENOENT' });
});

test('full repository checks remain opt-in', async t => {
  const f = await buildFixture(t);
  const result = run(f.script, ['--version', 'test', '--output-dir', f.output, '--full-check'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await f.commands()).filter(c => c.command === 'pnpm').map(c => c.args), [
    ['check'], ['--filter', '@termrelay/server', 'test'],
  ]);
});

test('failed build preserves the previous release; skip-check skips preflight tests', async t => {
  const f = await buildFixture(t);
  const oldArchive = join(f.output, 'termrelay-server-old-linux-arm64.tar.gz');
  await writeFile(oldArchive, 'previous release');
  const result = run(f.script, ['--version', 'test', '--output-dir', f.output, '--skip-check'],
    { ...f.env, MOCK_BUILD_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(oldArchive, 'utf8'), 'previous release');
  assert.equal((await f.commands()).filter(c => c.command === 'pnpm').length, 0);
});

test('deploy skips import only for an exact image ID and still runs migrations and health checks', async t => {
  const f = await deployFixture(t);
  const result = run(f.script, [], f.env);
  assert.equal(result.status, 0, result.stderr);
  const commands = await f.commands();
  assert.equal(commands.filter(c => c.command === 'docker' && c.args[0] === 'load').length, 0);
  assert.ok(commands.some(c => c.command === 'docker' && c.args.includes('migrate')));
  assert.ok(commands.some(c => c.command === 'docker' && c.args.includes('up')));
  assert.ok(commands.some(c => c.command === 'curl' && c.args.includes('--noproxy')));
});

test('deploy imports a same-tag image with different contents', async t => {
  const f = await deployFixture(t);
  const result = run(f.script, [], { ...f.env, MOCK_EXISTING_ID: `sha256:${'b'.repeat(64)}` });
  assert.equal(result.status, 0, result.stderr);
  const loads = (await f.commands()).filter(c => c.command === 'docker' && c.args[0] === 'load');
  assert.deepEqual(loads.map(c => c.args), [['load', '--input', join(f.directory, 'image.tar')]]);
});

test('deploy rejects an imported image whose ID differs from the manifest before migration', async t => {
  const f = await deployFixture(t);
  const result = run(f.script, [], {
    ...f.env, MOCK_EXISTING_ID: '', MOCK_LOADED_ID: `sha256:${'b'.repeat(64)}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the release manifest/);
  assert.equal((await f.commands()).filter(c => c.command === 'docker' && c.args.includes('migrate')).length, 0);
});

test('deploy keeps compatibility with gzip images and manifests without image IDs', async t => {
  const f = await deployFixture(t, { legacy: true });
  const result = run(f.script, ['--skip-migration'], f.env);
  assert.equal(result.status, 0, result.stderr);
  const commands = await f.commands();
  assert.deepEqual(commands.filter(c => c.command === 'docker' && c.args[0] === 'load').map(c => c.args),
    [['load', '--input', join(f.directory, 'image.tar.gz')]]);
  assert.equal(commands.filter(c => c.command === 'docker' && c.args.includes('migrate')).length, 0);
  assert.ok(commands.some(c => c.command === 'docker' && c.args.includes('up')));
});
