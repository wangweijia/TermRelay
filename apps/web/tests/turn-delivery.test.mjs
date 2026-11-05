import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { createServer } from 'vite';
import { renderToString } from 'vue/server-renderer';
import { createPinia, setActivePinia } from 'pinia';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';

let vite;
let useRelayStore;
let component;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const originalSocket = globalThis.WebSocket;
const storage = new Map();
before(async () => {
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { crypto: webcrypto, localStorage, confirm: () => true, location: { origin: 'http://localhost' } };
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: true }) });
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
  ({ useRelayStore } = await vite.ssrLoadModule('/src/stores/relay.ts'));
  ({ default: component } = await vite.ssrLoadModule('/src/components/StructuredAgentView.vue'));
});
after(async () => {
  await vite?.close();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalStorage;
  globalThis.WebSocket = originalSocket;
});
function store() {
  setActivePinia(createPinia());
  const relay = useRelayStore();
  relay.selectedSessionId = 'session';
  relay.sessions = [{ id: 'session', deviceId: 'mac', status: 'running', runtimeMode: 'acp' }];
  relay.devices = [{ id: 'mac', status: 'connected' }];
  const sent = [];
  relay.socket = { readyState: 1, send: value => sent.push(JSON.parse(value).data) };
  return { relay, sent };
}
function acknowledge(relay, record, status, scope = {}) {
  relay.handleSocketMessage({ data: JSON.stringify({ data: { type: 'command.ack', protocolVersion: '2',
    commandId: record.commandId, deviceId: 'mac', sessionId: 'session', ...scope,
    payload: { commandId: record.commandId, status } } }) });
}

test('store registers before sending and resolves a lost ACK through a status query without resending', async () => {
  const { relay, sent } = store();
  const record = relay.startToolTurn('hello', ['attachment']);
  assert.equal(sent.length, 1);
  assert.equal(record.messageId, sent[0].messageId);
  assert.equal(relay.startToolTurn('double click'), undefined);
  acknowledge(relay, record, 'completed', { sessionId: 'different' });
  assert.equal(record.state, 'waiting');
  record.createdAt -= 36_000;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await relay.reconcileTurnCommands();
  assert.equal(record.state, 'unknown');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ commandId: record.commandId, deviceId: 'mac', sessionId: 'session', ack: { commandId: record.commandId, status: 'completed' } }) });
  await relay.reconcileTurnCommands(true);
  assert.equal(record.state, 'confirmed');
  assert.equal(relay.commandStatus, undefined);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(storage.get('termrelay.turnReceipts.v1'), /hello|attachment/);
});

test('an explicit protocol error immediately unlocks the correct submission', () => {
  const { relay } = store();
  const record = relay.startToolTurn('hello');
  relay.handleSocketMessage({ data: JSON.stringify({ data: { type: 'protocol.error', protocolVersion: '2',
    payload: { relatedMessageId: record.messageId, code: 'unknown_device', message: 'offline' } } }) });
  assert.equal(record.state, 'not_sent');
});

// Render only setup into an in-memory Vue host: exercise the actual composer watchers
// without depending on a browser layout engine or starting a provider.
const renderer = createRenderer({ insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {} });
function composer(relay) {
  const props = reactive({ sessionId: 'session', events: [], interactive: true, turnReceipts: relay.selectedTurnReceipts,
    sendTurn: (...args) => { const record = relay.startToolTurn(...args); props.turnReceipts = relay.selectedTurnReceipts; return record; } });
  const child = { ...component, render: () => null, ssrRender: undefined };
  const app = renderer.createApp({ render: () => h(child, props) });
  app.provide(ssrContextKey, {});
  app.mount({});
  return { app, state: app._instance.subTree.component.setupState, props };
}

test('composer clears the original text and attachments only after explicit confirmation', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: true }) });
  const { relay } = store();
  const { app, state } = composer(relay);
  try {
    state.prompt = 'hello';
    state.draftAttachments = [{ metadata: { id: 'file' }, state: 'ready' }];
    state.submitTurn();
    const record = Object.values(relay.turnReceipts)[0];
    acknowledge(relay, record, 'accepted');
    await nextTick();
    assert.equal(state.prompt, 'hello');
    assert.equal(state.draftAttachments.length, 1);
    acknowledge(relay, record, 'completed');
    await nextTick();
    assert.equal(state.prompt, '');
    assert.equal(state.draftAttachments.length, 0);
  } finally { app.unmount(); }
});

test('composer preserves a revised draft and newly added attachments when confirmation arrives late', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ supported: true }) });
  const { relay } = store();
  const { app, state } = composer(relay);
  try {
    state.prompt = 'first';
    state.draftAttachments = [{ metadata: { id: 'old-file' }, state: 'ready' }];
    state.submitTurn();
    const record = Object.values(relay.turnReceipts)[0];
    acknowledge(relay, record, 'failed');
    await nextTick();
    state.prompt = 'new draft';
    state.draftAttachments.push({ metadata: { id: 'new-file' }, state: 'ready' });
    acknowledge(relay, record, 'completed');
    await nextTick();
    assert.equal(state.prompt, 'new draft');
    assert.deepEqual(state.draftAttachments.map(item => item.metadata.id), ['old-file', 'new-file']);
  } finally { app.unmount(); }
});


test('confirmed history never renders status lines, and multiple unknown receipts share one recovery button', async () => {
  const base = { messageId: 'message', deviceId: 'mac', sessionId: 'session', createdAt: 1_000 };
  const confirmed = [1, 2, 3].map(id => ({ ...base, commandId: `confirmed-${id}`, state: 'confirmed' }));
  const render = turnReceipts => renderToString(h(component, {
    sessionId: 'session', events: [], interactive: true, turnReceipts, sendTurn: () => undefined,
  }));
  const successHTML = await render(confirmed);
  assert.doesNotMatch(successHTML, /已交给设备处理|核实发送结果|aria-live="polite"/);
  const unknown = [1, 2, 3].map(id => ({ ...base, commandId: `unknown-${id}`, state: 'unknown' }));
  const unknownHTML = await render([...confirmed, ...unknown]);
  assert.doesNotMatch(unknownHTML, /已交给设备处理|aria-live="polite"/);
  assert.equal(unknownHTML.match(/核实发送结果/g)?.length, 1);
});

test('duplicate completed ACKs keep successful confirmations out of the global status', () => {
  const { relay } = store();
  const first = relay.startToolTurn('first');
  acknowledge(relay, first, 'completed');
  assert.equal(relay.commandStatus, undefined);
  const second = relay.startToolTurn('second');
  acknowledge(relay, second, 'completed');
  acknowledge(relay, first, 'completed');
  assert.equal(relay.commandStatus, undefined);
  assert.equal(first.state, 'confirmed');
  assert.equal(second.state, 'confirmed');
});
