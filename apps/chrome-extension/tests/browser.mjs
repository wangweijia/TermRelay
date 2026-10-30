import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
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
const timeout = setTimeout(() => browser.kill('SIGTERM'), 60_000);
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
async function screenshot(name, session) {
  const destination = process.env.TERMRELAY_UI_SCREENSHOTS;
  if (!destination) return;
  await mkdir(destination, { recursive: true });
  const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session);
  await writeFile(join(destination, `${name}.png`), Buffer.from(data, 'base64'));
}
const store = new Store(join(directory, 'feedback.json'));
await store.load();
const app = createCompanion({
  store, ports: [8080],
  binding: { sessionId: randomUUID(), deviceId: randomUUID(), workspaceId: randomUUID(), name: 'Synthetic preview' },
  reviewerToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64), adminToken: 'c'.repeat(64),
});
await new Promise(resolve => app.publicServer.listen(0, '127.0.0.1', resolve));
const companionURL = `http://127.0.0.1:${app.publicServer.address().port}`;
const probeServer = createServer(socket => socket.destroy());
await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
const probePort = probeServer.address().port;
let observedProxyAuthorization;
app.publicServer.on('connect', request => {
  if (request.url === `page-gateway-local.nioint.com:${probePort}` && request.headers['proxy-authorization']) {
    observedProxyAuthorization = request.headers['proxy-authorization'];
  }
});
try {
  const { id } = await call('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../extension/', import.meta.url)) }, null);
  const optionTarget = await call('Target.createTarget', { url: 'about:blank' }, null);
  const { sessionId: optionSession } = await call('Target.attachToTarget', { targetId: optionTarget.targetId, flatten: true }, null);
  await call('Page.enable', {}, optionSession);
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, optionSession);
  const optionsLoaded = new Promise(resolve => handlers.set('Page.loadEventFired', resolve));
  await call('Page.navigate', { url: `chrome-extension://${id}/options.html` }, optionSession);
  await optionsLoaded;
  async function waitOptions(condition, description) {
    const result = await evaluate(`new Promise(resolve=>{
      let attempts=0;const timer=setInterval(async()=>{
        if(${condition}){clearInterval(timer);resolve(true);}
        else if(++attempts>200){clearInterval(timer);resolve(document.querySelector('#status').textContent);}
      },25);
    })`, optionSession);
    assert.equal(result, true, description);
  }
  await waitOptions(`document.querySelector('main').getAttribute('aria-busy')==='false'`, 'options should initialize');
  assert.equal(await evaluate(`document.querySelector('#advanced').open`, optionSession), false, 'manual configuration stays out of the primary flow');
  assert.equal(await evaluate(`document.querySelector('#import-config').getBoundingClientRect().height>0`, optionSession), true, 'paste configuration is visible immediately');
  assert.equal(await evaluate(`document.querySelector('#import').disabled`, optionSession), true);
  async function paste(value) {
    await evaluate(`document.querySelector('#import-config').value=${JSON.stringify(value)};
      document.querySelector('#import-config').dispatchEvent(new Event('input'));
      document.querySelector('#import').click();`, optionSession);
  }
  await paste('not JSON');
  await waitOptions(`document.querySelector('#status').dataset.tone==='error' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'invalid paste should show a recoverable error');
  assert.match(await evaluate(`document.querySelector('#status').textContent`, optionSession), /不是完整配置/);
  await paste(JSON.stringify({ companionURL }));
  await waitOptions(`document.querySelector('#status').dataset.tone==='error' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'partial configuration should be rejected');
  assert.match(await evaluate(`document.querySelector('#status').textContent`, optionSession), /配置不完整/);
  await paste(JSON.stringify({ companionURL, reviewerToken: 'a'.repeat(64), proxyToken: 'b'.repeat(64) }));
  await waitOptions(`document.querySelector('#connection-badge').textContent==='已连接' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'pasting configuration should save and connect in one action');
  assert.equal(await evaluate(`document.querySelector('#import-config').value`, optionSession), '', 'clear pasted credentials after saving');
  assert.equal(await evaluate(`document.querySelector('#enable').disabled`, optionSession), true, 'proxy needs explicit consent even after successful pairing');
  assert.equal((await evaluate(`chrome.storage.local.get('proxyEnabled')`, optionSession)).proxyEnabled, undefined);
  assert.equal(await evaluate(`document.querySelector('#preview-links').hidden`, optionSession), true, 'do not offer unusable preview links before enabling the proxy');
  assert.ok(!(await evaluate(`document.querySelector('#status').textContent`, optionSession)).includes('a'.repeat(64)), 'status is human-readable and never dumps tokens');
  const connection = await evaluate(`chrome.runtime.sendMessage({type:'connection.test'})`, optionSession);
  assert.equal(connection.ok, true, connection.error);
  assert.deepEqual(connection.data.ports, [8080]);
  await evaluate(`document.querySelector('#consent').checked=true;document.querySelector('#consent').dispatchEvent(new Event('change'));
    document.querySelector('#enable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='已开启' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'primary preview action should enable the proxy');
  assert.equal(await evaluate(`document.querySelector('#preview-links a').href`, optionSession), 'https://page-gateway-local.nioint.com:8080/');
  assert.equal(await evaluate(`document.querySelector('.sidebar').getBoundingClientRect().bottom <= document.querySelector('.setup').getBoundingClientRect().top`, optionSession), true, 'settings use a single column with connection status above configuration');
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundImage`, optionSession), 'none', 'settings have no decorative background');
  assert.equal(await evaluate(`document.querySelectorAll('.brand-mark,.hero-tags,.step-number').length`, optionSession), 0, 'settings have no promotional decorations');
  await screenshot('options-desktop', optionSession);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, optionSession);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`, optionSession), true, 'settings fit a narrow viewport without horizontal scrolling');
  await screenshot('options-narrow', optionSession);
  await call('Emulation.clearDeviceMetricsOverride', {}, optionSession);
  const proxyState = await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession);
  assert.equal(proxyState.value.mode, 'pac_script');
  assert.match(proxyState.value.pacScript.data, /page-gateway-local/);
  assert.match(proxyState.value.pacScript.data, /DIRECT/);
  const priorLease = (await evaluate(`chrome.storage.local.get('connection')`, optionSession)).connection.connectionToken;
  await evaluate(`document.querySelector('#advanced').open=true;document.querySelector('#settings').requestSubmit();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='未开启' && document.querySelector('#connection-badge').textContent==='已连接' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'saving advanced configuration should release the old lease and reconnect without silently restoring the proxy');
  assert.notEqual((await evaluate(`chrome.storage.local.get('connection')`, optionSession)).connection.connectionToken, priorLease);
  assert.equal(await evaluate(`document.querySelector('#consent').checked`, optionSession), false, 'saving another configuration resets proxy consent');
  assert.equal(await evaluate(`document.querySelector('#enable').disabled`, optionSession), true);
  await evaluate(`document.querySelector('#consent').checked=true;document.querySelector('#consent').dispatchEvent(new Event('change'));
    document.querySelector('#enable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='已开启' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'preview can restart after a deliberate confirmation');
  await evaluate(`document.querySelector('#advanced').open=true;document.querySelector('#disable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='未开启' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'advanced pause should keep the App connection but disable the proxy');
  assert.equal(await evaluate(`document.querySelector('#connection-badge').textContent`, optionSession), '已连接');
  await evaluate(`document.querySelector('#advanced').open=false`, optionSession);
  await evaluate(`document.querySelector('#enable').click()`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='已开启' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'built-in preview should restart before switching ownership');
  await evaluate(`document.querySelector('[name="proxy-mode"][value="zeroomega"]').click()`, optionSession);
  await waitOptions(`document.querySelector('#zeroomega-setup').hidden===false && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'ZeroOmega choice should immediately show the generated setup');
  assert.equal((await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession)).levelOfControl, 'controllable_by_this_extension', 'switching away must release our active PAC');
  assert.equal(await evaluate(`document.querySelector('#consent').checked`, optionSession), false, 'switching modes needs fresh consent');
  assert.equal((await evaluate(`chrome.storage.local.get('proxyEnabled')`, optionSession)).proxyEnabled, false);
  assert.equal(await evaluate(`document.querySelector('#connection-badge').textContent`, optionSession), '已连接', 'mode switch preserves the App connection');
  const guide = await evaluate(`document.querySelector('#zeroomega-guide').value`, optionSession);
  assert.ok(guide.includes('127.0.0.1'));
  assert.ok(guide.includes(String(app.publicServer.address().port)));
  assert.ok(guide.includes('page-gateway-local.nioint.com'));
  assert.ok(guide.includes('保留其余规则与默认情景'));
  assert.ok(!guide.includes('a'.repeat(64)) && !guide.includes('b'.repeat(64)), 'quick setup never exports pairing credentials');
  assert.ok(!guide.includes((await evaluate(`chrome.storage.local.get('connection')`, optionSession)).connection.proxyToken), 'quick setup never exports the dynamic proxy credential');
  await evaluate(`Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.copiedGuide=text;}});
    document.querySelector('#copy-zeroomega').click();`, optionSession);
  await waitOptions(`document.querySelector('#status').textContent.includes('已复制') && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'quick setup copy should report success');
  assert.equal(await evaluate('window.copiedGuide', optionSession), guide);
  await evaluate(`Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('Clipboard unavailable');}});
    document.querySelector('#copy-zeroomega').click();`, optionSession);
  await waitOptions(`document.querySelector('#status').dataset.tone==='error' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'clipboard failure must be visible instead of reporting success');
  const externalDirectory = join(directory, 'external-proxy');
  await mkdir(externalDirectory);
  const externalPAC = `function FindProxyForURL(url,host){if(host==="page-gateway-local.nioint.com")return "PROXY 127.0.0.1:${app.publicServer.address().port}";return "DIRECT";}`;
  await writeFile(join(externalDirectory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'External proxy controller test fixture', version: '1.0',
    permissions: ['proxy'], background: { service_worker: 'background.js' },
  }));
  await writeFile(join(externalDirectory, 'background.js'), `chrome.proxy.settings.set({value:{mode:"pac_script",pacScript:{data:${JSON.stringify(externalPAC)}}},scope:"regular"});`);
  const { id: externalId } = await call('Extensions.loadUnpacked', { path: externalDirectory }, null);
  await waitOptions(`(await chrome.proxy.settings.get({incognito:false})).levelOfControl==='controlled_by_other_extensions'`, 'the second extension should own Chrome proxy settings');
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='ZeroOmega · 未确认'`, 'external mode should not mislabel another controller as a conflict');
  assert.equal((await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession)).levelOfControl, 'controlled_by_other_extensions');
  const externalState = await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession);
  await evaluate(`document.querySelector('#consent').checked=true;document.querySelector('#consent').dispatchEvent(new Event('change'));
    document.querySelector('#enable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='ZeroOmega · 待验证' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'external mode can connect with another proxy controller, without claiming verified routing');
  assert.deepEqual(await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession), externalState, 'external preview does not rewrite existing proxy rules');
  assert.equal(await evaluate(`document.querySelector('#preview-links').hidden`, optionSession), false);
  assert.equal(await evaluate(`document.querySelector('#disable').hidden`, optionSession), true, 'do not offer to pause a proxy we do not control');
  const probeResult = await evaluate(`fetch('https://page-gateway-local.nioint.com:${probePort}/',{signal:AbortSignal.timeout(5000)})
    .then(()=> 'unexpected success',error=>error.name)`, optionSession);
  assert.notEqual(probeResult, 'unexpected success', 'the synthetic target deliberately closes before TLS');
  const currentLease = (await evaluate(`chrome.storage.local.get('connection')`, optionSession)).connection;
  assert.equal(observedProxyAuthorization, `Basic ${Buffer.from(`preview:${currentLease.proxyToken}`).toString('base64')}`,
    'Chrome must dispatch real external-PAC proxy authentication to our extension and use the current lease credential');
  await screenshot('options-zeroomega', optionSession);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, optionSession);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`, optionSession), true, 'generated ZeroOmega setup fits narrow viewports');
  await screenshot('options-zeroomega-narrow', optionSession);
  await call('Emulation.clearDeviceMetricsOverride', {}, optionSession);
  const optionsReloaded = new Promise(resolve => handlers.set('Page.loadEventFired', resolve));
  await call('Page.reload', {}, optionSession);
  await optionsReloaded;
  await waitOptions(`document.querySelector('[name="proxy-mode"][value="zeroomega"]').checked && document.querySelector('#proxy-badge').textContent==='ZeroOmega · 待验证' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'external mode and deliberate confirmation survive reloading settings');
  await evaluate(`document.querySelector('[name="proxy-mode"][value="builtin"]').click()`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='代理受限制' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'returning to built-in mode must respect another proxy controller');
  assert.deepEqual(await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession), externalState);
  await call('Extensions.uninstall', { id: externalId }, null);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='未开启'`, 'built-in mode becomes available when the external controller releases its settings');
  assert.equal(await evaluate(`document.querySelector('#consent').checked`, optionSession), false);
  await evaluate(`document.querySelector('#consent').checked=true;document.querySelector('#consent').dispatchEvent(new Event('change'));
    document.querySelector('#enable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='已开启' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'built-in mode still works after a round trip through ZeroOmega');
  await evaluate(`document.querySelector('[name="proxy-mode"][value="zeroomega"]').click()`, optionSession);
  await waitOptions(`document.querySelector('#zeroomega-setup').hidden===false && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'return to external mode for the feedback lifecycle test');
  await call('Extensions.loadUnpacked', { path: externalDirectory }, null);
  await waitOptions(`(await chrome.proxy.settings.get({incognito:false})).levelOfControl==='controlled_by_other_extensions'`, 'external proxy ownership should return before testing feedback');
  await evaluate(`document.querySelector('#consent').checked=true;document.querySelector('#consent').dispatchEvent(new Event('change'));
    document.querySelector('#enable').click();`, optionSession);
  await waitOptions(`document.querySelector('#proxy-badge').textContent==='ZeroOmega · 待验证' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'external preview can resume after mode switching');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  ({ sessionId } = await call('Target.attachToTarget', { targetId, flatten: true }, null));
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Runtime.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const assets = new Set();
  handlers.set('Fetch.requestPaused', params => {
    const url = new URL(params.request.url);
    const html = '<!doctype html><meta charset=utf-8><link rel=stylesheet href="https://page-gateway-local.nioint.com:8102/__debug/index.css"><script src="https://page-gateway-local.nioint.com:8102/__debug/index.js"></script><button id=query><span>Query</span></button><input id=password type=password value=DO-NOT-COLLECT><script>window.businessClicks=0;document.querySelector("#query").onclick=()=>window.businessClicks++;</script>';
    let content = html, type = 'text/html; charset=utf-8';
    if (url.pathname === '/__debug/index.css') {
      assets.add(params.request.url); content = '#query{color:rgb(12, 34, 56)}'; type = 'text/css';
    } else if (url.pathname === '/__debug/index.js') {
      assets.add(params.request.url); content = 'window.secondaryScriptLoaded=true;'; type = 'text/javascript';
    }
    call('Fetch.fulfillRequest', {
      requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: type }],
      body: Buffer.from(content).toString('base64'),
    }).catch(error => { console.error(error.message); browser.kill('SIGTERM'); });
  });
  const loaded = new Promise(resolve => handlers.set('Page.loadEventFired', resolve));
  await call('Page.navigate', { url: 'https://page-gateway-local.nioint.com:8101/debug/test?token=DO-NOT-COLLECT' });
  await loaded;
  assert.equal(assets.size, 2, 'cross-port CSS and JS should both load');
  assert.equal(await evaluate('window.secondaryScriptLoaded'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#query")).color'), 'rgb(12, 34, 56)');
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
  assert.equal((await within(`return this.querySelector('#toggle').textContent;`)).trim(), '点点改');
  await within(`this.querySelector('#toggle').click();`);
  assert.equal(await within(`return this.querySelector('#panel-title').textContent;`), '点点改');
  assert.equal(await within(`return this.querySelectorAll('svg,.brand-mark,.step-heading span').length;`), 0, 'panel uses text controls without decorative icons or numbered steps');
  assert.equal(await within(`return getComputedStyle(this.querySelector('.panel-header')).backgroundImage;`), 'none');
  assert.equal(await within(`return getComputedStyle(this.querySelector('#panel')).boxShadow;`), 'none');
  await screenshot('panel-desktop', sessionId);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await within(`const panel=this.querySelector('#panel'),rect=panel.getBoundingClientRect();
    return rect.left>=0 && rect.right<=innerWidth && panel.scrollWidth<=panel.clientWidth;`), true, 'business panel fits the viewport without horizontal overflow');
  await screenshot('panel-narrow', sessionId);
  await call('Emulation.clearDeviceMetricsOverride');
  await within(`this.querySelector('#pick').click();this.querySelector('#toggle').click();`);
  assert.equal(await within(`return this.querySelector('#hint').hidden && !this.querySelector('#panel').hidden && this.querySelector('#toggle').getAttribute('aria-expanded')==='true';`), true, 'floating button exits selection and reopens the panel');
  await within(`this.querySelector('#pick').click();`);
  await evaluate(`document.querySelector('#query span').click();`);
  assert.equal(await evaluate('businessClicks'), 0, 'selection must not trigger the business action');
  assert.match(await within("return this.querySelector('#object').textContent;"), /button.*Query/);
  await within(`this.querySelector('#description').value='Make the button clearer';this.querySelector('#submit').click();`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
  const feedback = store.records[0];
  assert.equal(feedback.element.tag, 'button');
  assert.equal(feedback.element.text, 'Query');
  assert.equal(feedback.page, 'https://page-gateway-local.nioint.com:8101/debug/test');
  assert.ok(!JSON.stringify(feedback).includes('DO-NOT-COLLECT'));
  assert.match(await within("return this.querySelector('#status').textContent;"), /已提交/);
  assert.match(await within("return this.querySelector('#connection').textContent;"), /已连接 App/);
  async function waitForLabel(label) {
    assert.equal(await within(`return new Promise(resolve=>{
      let attempts=0;const timer=setInterval(()=>{
        if(this.querySelector('#records').textContent.includes(${JSON.stringify(label)})){clearInterval(timer);resolve(true);}
        else if(++attempts>60){clearInterval(timer);resolve(false);}
      },100);
    });`), true, `extension must automatically show ${label} without a refresh click`);
  }
  for (const [status, label] of [
    ['running', 'AI 正在修改'],
    ['awaiting_approval', '等待 Chat 工具审批'],
    ['awaiting_review', '本轮修改完成'],
  ]) {
    feedback.status = status;
    feedback.note = status === 'awaiting_review' ? 'Synthetic local turn completed; verify the page.' : '';
    await store.save();
    await waitForLabel(label);
  }
  await within(`Array.from(this.querySelectorAll('#records button')).find(b=>b.textContent==='效果满意').click();`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
  assert.equal(feedback.status, 'verified');
  await within(`this.querySelector('#new').click();this.querySelector('#whole').click();this.querySelector('#description').value='Page-level feedback';this.querySelector('#submit').click();`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
  assert.equal(store.records[0].element, null);
  await evaluate("document.querySelector('#query').click()");
  assert.equal(await evaluate('businessClicks'), 1, 'normal browsing must work after selection');
  await evaluate(`document.querySelector('#disconnect').click()`, optionSession);
  await waitOptions(`document.querySelector('#connection-badge').textContent==='未连接' && document.querySelector('main').getAttribute('aria-busy')==='false'`, 'end connection should release the plugin from the settings UI');
  assert.equal(await within(`return new Promise(resolve=>{
    let attempts=0;const timer=setInterval(()=>{
      if(this.querySelector('#connection').textContent.includes('App 未连接')){clearInterval(timer);resolve(true);}
      else if(++attempts>60){clearInterval(timer);resolve(false);}
    },100);
  });`), true, 'explicit disconnect must remain disconnected even while preview tabs are open');
  assert.equal(await within("return this.querySelector('#submit').disabled;"), true);
  assert.equal((await evaluate(`chrome.storage.local.get('connection')`, optionSession)).connection, undefined);
  assert.deepEqual(await evaluate(`chrome.proxy.settings.get({incognito:false})`, optionSession), externalState, 'disconnect releases our lease, not the external controller or its rules');
  console.log('Chrome UI: paste-first pairing, explicit consent, built-in/ZeroOmega switching and persistence, copyable credential-free setup, external proxy ownership, responsive layout, feedback lifecycle, disconnect, cross-port assets and private selection passed.');
} finally {
  clearTimeout(timeout);
  await call('Browser.close', {}, null).catch(() => {});
  if (browser.exitCode === null) await Promise.race([once(browser, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (browser.exitCode === null) { browser.kill('SIGTERM'); await once(browser, 'exit'); }
  app.closeProxy();
  await new Promise(resolve => probeServer.close(resolve));
  await new Promise(resolve => { app.publicServer.close(resolve); app.publicServer.closeAllConnections(); });
  await rm(directory, { recursive: true });
}
