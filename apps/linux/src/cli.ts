import { Command, CommanderError, Option } from 'commander';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigStore, readCredential } from './config.js';
import { withLock, locked } from './process.js';
import { pairDevice } from './pairing.js';
import { AgentService } from './service.js';
import { VERSION, errorMessage, executable, findExecutable, record, serverURL } from './util.js';

export async function main(argv = process.argv): Promise<number> {
  let exitCode = 0;
  const program = new Command().name('termrelay-agent').description('TermRelay TypeScript headless Linux Agent')
    .version(VERSION).option('--config <path>', 'Agent configuration path').exitOverride();
  const store = (): ConfigStore => new ConfigStore(program.opts<{ config?: string }>().config);
  const edit = async (action: (store: ConfigStore) => Promise<void> | void): Promise<void> => {
    const config = store(); await withLock(config.lockPath, async () => action(config));
  };
  program.command('configure').requiredOption('--server <url>').option('--name <name>')
    .action(async (options: { server: string; name?: string }) => edit(s => {
      console.log(`Configured device ${s.configure(options.server, options.name).deviceId}`);
    }));
  const workspace = program.command('workspace').description('Manage locally authorized directories');
  workspace.command('add <path>').requiredOption('--name <name>').option('--allow-remote-start', 'Allow Web to create sessions in this directory')
    .action(async (path: string, options: { name: string; allowRemoteStart?: boolean }) => edit(s => {
      const config = s.load(), real = realpathSync(resolve(path));
      if (!statSync(real).isDirectory() || config.workspaces.some(w => w.path === real)) throw new Error('Workspace must be a new existing directory');
      config.workspaces.push({ id: randomUUID(), name: options.name, path: real, remoteStartAllowed: options.allowRemoteStart === true }); s.save(config);
    }));
  workspace.command('remote-start <name>').requiredOption('--allow <boolean>', 'true or false')
    .action(async (name: string, options: { allow: string }) => edit(s => {
      const config = s.load(), entry = config.workspaces.find(w => w.name === name);
      if (!entry || !['true', 'false'].includes(options.allow)) throw new Error('Specify an existing workspace and --allow true or false');
      entry.remoteStartAllowed = options.allow === 'true'; s.save(config);
    }));
  workspace.command('list').action(() => console.log(JSON.stringify(store().load().workspaces, null, 2)));
  workspace.command('remove <name>').action(async (name: string) => edit(s => {
    const config = s.load(), workspace = config.workspaces.find(w => w.name === name);
    if (!workspace || config.sessions.some(p => p.workspaceId === workspace.id)) throw new Error('Workspace missing or referenced by a startup profile');
    config.workspaces = config.workspaces.filter(w => w.id !== workspace.id); s.save(config);
  }));
  const session = program.command('session').description('Startup profiles, NOT remote session creation');
  session.command('add').requiredOption('--workspace <name>')
    .addOption(new Option('--provider <provider>').choices(['shell', 'codex']).default('codex'))
    .action(async (options: { workspace: string; provider: 'shell' | 'codex' }) => edit(s => {
      const config = s.load(), workspace = config.workspaces.find(w => w.name === options.workspace);
      if (!workspace) throw new Error('Register workspace first');
      const id = randomUUID();
      config.sessions.push({ id, workspaceId: workspace.id, provider: options.provider }); s.save(config);
      console.log(`Added startup profile ${id}; run creates a new session without submitting a prompt`);
    }));
  session.command('list').action(() => console.log(JSON.stringify(store().load().sessions, null, 2)));
  session.command('remove <id>').action(async (id: string) => edit(s => {
    const config = s.load();
    if (!config.sessions.some(p => p.id === id)) throw new Error('Startup profile not found');
    config.sessions = config.sessions.filter(p => p.id !== id); s.save(config);
  }));
  program.command('tool <provider> <path>').action(async (provider: string, path: string) => edit(s => {
    if (provider !== 'codex') throw new Error('Only codex is supported');
    const real = realpathSync(resolve(path));
    if (!executable(real)) throw new Error('Tool must be an executable file');
    const config = s.load(); config.tools.codex = real; s.save(config);
  }));
  program.command('pair').requiredOption('--credential-file <path>', 'Explicit private plaintext credential file')
    .action(async (options: { credentialFile: string }) => edit(s => pairDevice(s, s.load(), options.credentialFile)));
  program.command('status').action(() => {
    const s = store(), config = s.load();
    const status = record(JSON.parse(readFileSync(s.statusPath, 'utf8')));
    if (status.deviceId !== config.deviceId || status.serverURL !== config.serverURL) throw new Error('Status belongs to an old configuration');
    console.log(JSON.stringify({ ...status, running: locked(s.lockPath), note: 'Last local snapshot; lock ownership does not imply Server connectivity' }, null, 2));
  });
  program.command('doctor').description('Check environment without starting providers or model requests').action(() => {
    const config = store().load();
    const checks = [
      { name: 'platform', ok: process.platform === 'linux', detail: process.platform },
      { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version },
      ...config.workspaces.map(w => ({ name: `workspace:${w.name}`, ok: existsSync(w.path) && statSync(w.path).isDirectory() })),
      ...[...new Set([
        ...config.sessions.map(s => s.provider),
        ...(config.workspaces.some(w => w.remoteStartAllowed) ? ['shell', ...(config.tools.codex ? ['codex'] : [])] : []),
      ])].map(provider => ({
        name: provider, ok: !!findExecutable(provider === 'shell' ? process.env.SHELL || '/bin/bash' : config.tools.codex || 'codex'),
      })),
      { name: 'credential', ok: serverURL(config.serverURL).pathname !== '/ws/client-public' || !!readCredential(config) },
    ];
    console.log(JSON.stringify(checks, null, 2)); exitCode = checks.every(c => c.ok) ? 0 : 1;
  });
  program.command('run').description('Run foreground; use the user systemd unit for background operation').action(async () => {
    if (process.platform !== 'linux') throw new Error('The service requires Linux; management and tests also run on POSIX development hosts');
    const s = store();
    exitCode = await withLock(s.lockPath, async () => new AgentService(s).run());
  });
  try { await program.parseAsync(argv); return exitCode; }
  catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    console.error(`TermRelay: ${errorMessage(error)}`); return 1;
  }
}

if (require.main === module) {
  void main().then(code => { process.exitCode = code; }, error => { console.error(`TermRelay: ${errorMessage(error)}`); process.exitCode = 1; });
}
