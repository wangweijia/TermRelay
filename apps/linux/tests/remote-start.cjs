const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const serverRequire = createRequire(join(__dirname, '../../server/package.json'));
const { Module } = serverRequire('@nestjs/common');
const { NestFactory } = serverRequire('@nestjs/core');
const { FastifyAdapter } = serverRequire('@nestjs/platform-fastify');
const { WsAdapter } = serverRequire('@nestjs/platform-ws');
const { ClientGateway } = serverRequire('./dist/realtime/client.gateway');
const { ProtocolValidator } = serverRequire('./dist/realtime/protocol-validator');
const { DeviceConnectionRegistry } = serverRequire('./dist/realtime/device-connection.registry');
const { SessionsService } = serverRequire('./dist/sessions/sessions.service');
const { SessionStartService } = serverRequire('./dist/sessions/session-start.service');
const { SessionStartController } = serverRequire('./dist/sessions/session-start.controller');
const { ConfigStore } = require('../dist/src/config');
const { AgentService } = require('../dist/src/service');
const { CodexRuntime } = require('../dist/src/codex');
const { JsonLineClient } = require('../dist/src/rpc');

async function until(check) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Remote creation integration timed out');
}

async function main() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'termrelay-remote-wire-')));
  const requests = new Map(), workspaces = new Map(), sessions = new Map(), events = new Map();
  const registry = new DeviceConnectionRegistry();
  const store = {
    find: async id => requests.get(id) ?? null,
    reserve: async (id, deviceId, request) => {
      if (requests.has(id)) return false;
      requests.set(id, { id, deviceId, request, status: 'pending', message: null, createdAt: new Date() });
      return true;
    },
    update: async (id, status, message) => {
      const row = requests.get(id);
      if (row && ['pending', 'accepted', 'unknown'].includes(row.status)) Object.assign(row, { status, message });
    },
    markUnknown: async deviceId => {
      for (const row of requests.values()) if ((!deviceId || row.deviceId === deviceId) && ['pending', 'accepted'].includes(row.status)) row.status = 'unknown';
    },
    countPending: async deviceId => [...requests.values()].filter(row => row.deviceId === deviceId && ['pending', 'accepted'].includes(row.status)).length,
  };
  const workspaceStore = {
    enabled: true, findById: async id => workspaces.get(id) ?? null,
    listRemote: async () => [...workspaces.values()].filter(w => w.available && w.remoteStartAllowed),
  };
  const acceptEvent = async (deviceId, id, seq, payload) => {
    const session = sessions.get(id);
    assert.equal(session.deviceId, deviceId);
    assert.equal(seq, session.stateVersion + 1);
    session.stateVersion = seq;
    events.get(id).push(payload);
    return { status: 'accepted' };
  };
  const relaySessions = {
    findById: async id => sessions.get(id), list: async () => [...sessions.values()],
    findOwnedSession: async (deviceId, id) => sessions.get(id)?.deviceId === deviceId ? sessions.get(id) : undefined,
    registerWorkspace: async (deviceId, payload) => {
      workspaces.set(payload.workspaceId, { ...payload, id: payload.workspaceId, deviceId });
      return { status: 'accepted' };
    },
    registerSession: async (deviceId, id, payload) => {
      sessions.set(id, { ...payload, id, deviceId, status: 'running', stateVersion: 0, autoApproveEnabled: false, origin: 'local' });
      events.set(id, []);
      return { status: 'accepted' };
    },
    appendTerminalOutput: acceptEvent, appendToolEvent: acceptEvent,
    finishReportedSession: async (_deviceId, id, payload) => {
      sessions.get(id).status = payload.status;
      return { status: 'accepted' };
    },
  };
  const starts = new SessionStartService(store, workspaceStore, registry, relaySessions);
  class Harness {}
  Module({
    controllers: [SessionStartController],
    providers: [
      ClientGateway, ProtocolValidator,
      { provide: DeviceConnectionRegistry, useValue: registry },
      { provide: SessionsService, useValue: relaySessions },
      { provide: SessionStartService, useValue: starts },
    ],
  })(Harness);
  const app = await NestFactory.create(Harness, new FastifyAdapter(), { logger: false });
  app.useWebSocketAdapter(new WsAdapter(app));
  let agent, running;
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const configStore = new ConfigStore(join(root, 'agent.json'));
    const config = configStore.configure(`${origin.replace('http:', 'ws:')}/ws/client`, 'Remote integration');
    const workspaceId = randomUUID();
    config.workspaces = [{ id: workspaceId, name: 'Project', path: root, remoteStartAllowed: true }];
    config.tools.codex = process.execPath;
    configStore.save(config);
    let launches = 0;
    agent = new AgentService(configStore, {
      log: message => { if (message.includes('failed')) console.error(message); },
      codex: (_path, cwd, emit) => {
        launches++;
        return new CodexRuntime('synthetic', cwd, emit, (_argv, directory, receive, fail) =>
          new JsonLineClient([process.execPath, join(__dirname, '../dist/tests/fixtures/fake-codex.js')], directory, receive, fail));
      },
    });
    running = agent.run();
    await until(() => agent.state === 'online' && workspaces.size === 1);
    async function request(path, body) {
      const response = await fetch(`${origin}/api/session-starts${path}`, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : undefined);
      assert.equal(response.ok, true, await response.clone().text());
      return response.json();
    }
    const targets = await request('/targets');
    assert.equal(targets[0].workspaceId, workspaceId);
    assert.equal(JSON.stringify(targets).includes(root), false);
    assert.equal(sessions.size, 0);
    const id = randomUUID();
    const body = { requestId: id, deviceId: config.deviceId, workspaceId, toolKey: 'codex', runtimeMode: 'acp', displayName: 'Remote Codex' };
    await Promise.all([request('', body), request('', body)]);
    await until(async () => (await request(`/${id}`)).status === 'completed');
    assert.equal(launches, 1);
    assert.equal(sessions.get(id).displayName, 'Remote Codex');
    const turn = randomUUID();
    registry.getClient(config.deviceId).send(JSON.stringify({ event: 'message', data: {
      type: 'tool.turn.start', protocolVersion: '2', messageId: randomUUID(), deviceId: config.deviceId,
      sessionId: id, commandId: turn, sentAt: new Date().toISOString(), payload: { text: 'Remote synthetic turn' },
    } }));
    await until(() => events.get(id).some(event => event.kind === 'turn.completed'));
    assert.equal(events.get(id).some(event => event.kind === 'user.message'), true);
    const pty = randomUUID();
    await request('', { ...body, requestId: pty, toolKey: 'shell', runtimeMode: 'pty', rows: 24, columns: 80 });
    await until(async () => (await request(`/${pty}`)).status === 'completed');
    assert.equal(agent.terminals.has(pty), true);
    assert.equal(sessions.get(pty).runtimeMode, 'pty');
    assert.equal(JSON.stringify([...requests.values()]).includes(root), false);
    console.log('Remote HTTP -> Server gateway -> Linux -> synthetic Codex / real PTY -> creation result passed (in-memory test repositories).');
  } finally {
    try {
      agent?.stop();
      if (running) assert.equal(await running, 0);
    } finally {
      try { await app.close(); }
      finally { rmSync(root, { recursive: true }); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
