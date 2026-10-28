import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../companion/store.mjs';
import { createCompanion } from '../companion/server.mjs';

const executable = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const directory = await mkdtemp(join(tmpdir(), 'termrelay-browser-test-'));
const browser = spawn(executable, [
  '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${directory}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', sessionId;
const pending = new Map(), handlers = new Map();
const timeout = setTimeout(() => browser.kill('SIGTERM'), 30_000);
browser.on('error', error => { for (const { reject } of pending.values()) reject(error); });
browser.on('exit', () => { for (const { reject } of pending.values()) reject(new Error('Chrome exited.')); });
function call(method, params = {}, session = sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`);
  });
}
browser.stdio[4].on('data', chunk => {
  buffer += chunk;
  let boundary;
  while ((boundary = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    } else handlers.get(message.method)?.(message.params);
  }
});
async function evaluate(expression, session = sessionId) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const store = new Store(join(directory, 'feedback.json'));
await store.load();
const app = createCompanion({
  store, relay: {}, ports: [8080],
  binding: { sessionId: randomUUID(), deviceId: randomUUID(), workspaceId: randomUUID(), name: 'Synthetic preview' },
  reviewerToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), adminToken: 'c'.repeat(64),
});
await new Promise(resolve => app.publicServer.listen(0, '127.0.0.1', resolve));
const companionURL = `http://127.0.0.1:${app.publicServer.address().port}`;
try {
  const { id } = await call('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../extension/', import.meta.url)) }, null);
  const optionTarget = await call('Target.createTarget', { url: 'about:blank' }, null);
  const { sessionId: optionSession } = await call('Target.attachToTarget', { targetId: optionTarget.targetId, flatten: true }, null);
  await call('Page.enable', {}, optionSession);
  const optionsLoaded = new Promise(resolve => handlers.set('Page.loadEventFired', resolve));
  await call('Page.navigate', { url: `chrome-extension://${id}/options.html` }, optionSession);
  await optionsLoaded;
  const pairing = await evaluate(`chrome.runtime.sendMessage({type:'settings.save',config:{
    companionURL:${JSON.stringify(companionURL)},reviewerToken:${JSON.stringify('a'.repeat(64))},proxyToken:${JSON.stringify('b'.repeat(64))}
  }})`, optionSession);
  assert.equal(pairing.ok, true, pairing.error);
  const connection = await evaluate(`chrome.runtime.sendMessage({type:'connection.test'})`, optionSession);
  assert.equal(connection.ok, true, connection.error);
  assert.deepEqual(connection.data.ports, [8080]);
  const enabled = await evaluate(`chrome.runtime.sendMessage({type:'proxy.set',enabled:true})`, optionSession);
  assert.equal(enabled.ok, true, enabled.error);
  const proxyState = await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession);
  assert.equal(proxyState.value.mode, 'pac_script');
  assert.match(proxyState.value.pacScript.data, /page-gateway-local/);
  assert.match(proxyState.value.pacScript.data, /DIRECT/);
  assert.equal((await evaluate(`chrome.runtime.sendMessage({type:'proxy.set',enabled:false})`, optionSession)).ok, true);
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  handlers.set('Fetch.requestPaused', params => {
    const html = '<!doctype html><meta charset=utf-8><button id=query><span>Query</span></button><input id=password type=password value=DO-NOT-COLLECT><script>window.businessClicks=0;document.querySelector("#query").onclick=()=>window.businessClicks++;</script>';
    call('Fetch.fulfillRequest', {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(html).toString('base64'),
    }).catch(error => { console.error(error.message); browser.kill('SIGTERM'); });
  });
  const loaded = new Promise(resolve => handlers.set('Page.loadEventFired', resolve));
  await call('Page.navigate', { url: 'https://page-gateway-local.nioint.com:8080/debug/test?token=DO-NOT-COLLECT' });
  await loaded;
  assert.equal(await evaluate(`new Promise(resolve => {
    let attempts=0; const timer=setInterval(()=>{
      if(document.querySelector('termrelay-feedback')) {clearInterval(timer);resolve(true);}
      else if(++attempts>50){clearInterval(timer);resolve(false);}
    },100);
  })`), true, 'installed extension should mount using the actual background worker and companion');
  const tree = (await call('DOM.getDocument', { depth: -1, pierce: true })).root;
  function findHost(item) {
    if (item.localName === 'termrelay-feedback') return item;
    for (const child of [...item.children || [], ...item.shadowRoots || []]) {
      const found = findHost(child);
      if (found) return found;
    }
  }
  const shadow = findHost(tree)?.shadowRoots?.[0];
  assert.ok(shadow, 'closed production shadow root must exist');
  const { object } = await call('DOM.resolveNode', { nodeId: shadow.nodeId });
  async function within(body) {
    const result = await call('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: `function(){${body}}`,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await within(`this.querySelector('#toggle').click();this.querySelector('#pick').click();`);
  await evaluate(`document.querySelector('#query span').click();`);
  assert.equal(await evaluate('businessClicks'), 0, 'selection must not trigger the business action');
  assert.match(await within("return this.querySelector('#object').textContent;"), /button.*Query/);
  await within(`this.querySelector('#description').value='Make the button clearer';this.querySelector('#submit').click();`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
  const feedback = store.records[0];
  assert.equal(feedback.element.tag, 'button');
  assert.equal(feedback.element.text, 'Query');
  assert.equal(feedback.page, 'https://page-gateway-local.nioint.com:8080/debug/test');
  assert.ok(!JSON.stringify(feedback).includes('DO-NOT-COLLECT'));
  assert.match(await within("return this.querySelector('#status').textContent;"), /已提交/);
  await within(`this.querySelector('#new').click();this.querySelector('#whole').click();this.querySelector('#description').value='Page-level feedback';this.querySelector('#submit').click();`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
  assert.equal(store.records[0].element, null);
  await evaluate("document.querySelector('#query').click()");
  assert.equal(await evaluate('businessClicks'), 1, 'normal browsing must work after selection');
  console.log('Chrome UI: selection, business-click isolation, text submission, URL sanitization, and whole-page feedback passed.');
} finally {
  clearTimeout(timeout);
  await call('Browser.close', {}, null).catch(() => {});
  if (browser.exitCode === null) await Promise.race([once(browser, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (browser.exitCode === null) { browser.kill('SIGTERM'); await once(browser, 'exit'); }
  app.closeProxy();
  await new Promise(resolve => { app.publicServer.close(resolve); app.publicServer.closeAllConnections(); });
  await rm(directory, { recursive: true });
}
