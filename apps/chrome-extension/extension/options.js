const $ = selector => document.querySelector(selector);
let state = {}, meta, busy = true, connectionIssue = false;
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || '插件后台未响应，请重新加载插件。');
  return reply.data;
}
function showStatus(message, tone = 'info') {
  $('#status').hidden = !message;
  $('#status').textContent = message;
  $('#status').dataset.tone = tone;
  $('#status').setAttribute('role', tone === 'error' ? 'alert' : 'status');
}
function badge(selector, text, tone = '') {
  $(selector).textContent = text;
  $(selector).dataset.state = tone;
}
function render() {
  const configured = !!state.config;
  const connected = state.connected && !connectionIssue;
  const proxyBlocked = state.levelOfControl && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(state.levelOfControl);
  const previewing = state.proxyEnabled && state.levelOfControl === 'controlled_by_this_extension';
  badge('#config-badge', configured ? '已保存' : '待配置', configured ? 'success' : '');
  badge('#connection-badge', connected ? '已连接' : '未连接', connected ? 'success' : '');
  badge('#proxy-badge', proxyBlocked ? '代理受限制' : previewing ? connected ? '已开启' : '等待 App' : '未开启', proxyBlocked || (previewing && !connected) ? 'warning' : previewing ? 'success' : '');
  $('#saved-config').hidden = !configured;
  $('#preview-links').hidden = !previewing || !connected;
  $('#saved-address').textContent = state.config?.companionURL || '';
  $('#connection-help').textContent = connectionIssue || state.connectionError ? '连接遇到问题，请确认 Mac 已开启共享，再重新连接。'
    : previewing && connected ? '一切就绪。打开下方入口，在业务页面点击「点点改」。'
      : connected ? '已连接开发者 Mac。确认使用范围后，开启预览即可访问页面。'
        : configured ? '配置已保存。开启预览时会自动连接 App。' : '先粘贴配置，把浏览器和开发者 Mac 连起来。';
  for (const control of document.querySelectorAll('button,input,textarea')) control.disabled = busy;
  $('#enable').disabled = busy || !configured || !$('#consent').checked || proxyBlocked || (previewing && connected);
  $('#enable').textContent = previewing && connected ? '预览已开启' : '开启预览 ↗';
  $('#disconnect').disabled = busy || !configured;
  $('#test').disabled = busy || !configured;
  $('#disable').disabled = busy || !state.proxyEnabled;
  $('#import').disabled = busy || !$('#import-config').value.trim();
  document.querySelector('main').setAttribute('aria-busy', String(busy));
}
function fillManualFields() {
  $('#url').value = state.config?.companionURL || '';
  $('#reviewer').value = state.config?.reviewerToken || '';
  $('#proxy').value = state.config?.proxyToken || '';
}
async function refreshState() {
  state = await send({ type: 'settings.get' });
  render();
}
function renderLinks() {
  $('#preview-links').replaceChildren();
  for (const port of meta?.ports || []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('App 返回的预览端口无效，请检查共享设置。');
    const link = document.createElement('a');
    link.href = `https://page-gateway-local.nioint.com:${port}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `打开预览 · 端口 ${port} ↗`;
    $('#preview-links').append(link);
  }
}
async function connect() {
  try {
    meta = await send({ type: 'connection.test' });
    connectionIssue = false;
    renderLinks();
  } catch (error) {
    connectionIssue = true;
    throw error;
  }
}
async function run(action, progress) {
  if (busy) return;
  busy = true; render(); showStatus(progress);
  try { showStatus(await action(), 'success'); }
  catch (error) { showStatus(error.message, 'error'); }
  finally {
    try { await refreshState(); }
    catch (error) { showStatus(`无法更新连接状态：${error.message}`, 'error'); }
    busy = false; render();
  }
}
async function saveAndConnect(config) {
  await send({ type: 'settings.save', config });
  connectionIssue = false; meta = undefined;
  $('#preview-links').replaceChildren();
  $('#consent').checked = false;
  await refreshState();
  fillManualFields();
  $('#import-config').value = '';
  try { await connect(); }
  catch (error) { throw new Error(`配置已保存，但暂时连不上 App：${error.message}`); }
  return '配置已保存，App 连接成功。再确认一下使用范围，点击「开启预览」就可以了。';
}
$('#import-config').oninput = render;
$('#consent').onchange = render;
$('#import').onclick = () => run(async () => {
  let config;
  try { config = JSON.parse($('#import-config').value); }
  catch { throw new Error('这段内容不是完整配置。请在 App 点击「复制插件配对配置」，再原样粘贴过来。'); }
  if (!config || Array.isArray(config) || !['companionURL', 'reviewerToken', 'proxyToken'].every(key => typeof config[key] === 'string')) {
    throw new Error('配置不完整。请复制 App 提供的整段插件配对配置，而不是网址或某一项密钥。');
  }
  return saveAndConnect(config);
}, '正在保存配置并连接开发者 Mac…');
$('#settings').onsubmit = event => {
  event.preventDefault();
  run(() => saveAndConnect({
    companionURL: $('#url').value.trim(), reviewerToken: $('#reviewer').value.trim(), proxyToken: $('#proxy').value.trim(),
  }), '正在保存配置并连接开发者 Mac…');
};
$('#enable').onclick = () => run(async () => {
  if (!$('#consent').checked) throw new Error('请先确认当前 Chrome 用户配置可以使用此预览代理。');
  await connect();
  await send({ type: 'proxy.set', enabled: true });
  return '预览已开启！点击右侧入口，进入项目页面后打开「点点改」。如果之前开过预览页，请关闭后重新打开。';
}, '正在连接并开启预览…');
$('#test').onclick = () => run(async () => { await connect(); return 'App 连接正常，可以继续预览与提交想法。'; }, '正在检查 App 连接…');
$('#disconnect').onclick = () => run(async () => {
  await send({ type: 'connection.disconnect' });
  connectionIssue = false;
  return '已结束连接并关闭代理。其他插件现在可以接入；已经提交的改动任务不会因此取消。';
}, '正在结束连接…');
$('#disable').onclick = () => run(async () => {
  await send({ type: 'proxy.set', enabled: false });
  return '页面代理已暂停，App 连接仍保留。如需让其他验收者接入，请点击「结束本次连接」。';
}, '正在暂停预览代理…');
async function initialize() {
  try {
    await refreshState();
    fillManualFields();
    $('#consent').checked = !!state.proxyEnabled;
    if (state.connected) await connect();
  } catch (error) { showStatus(`暂时无法读取或连接环境：${error.message}`, 'error'); }
  finally { busy = false; render(); }
}
initialize();
setInterval(() => {
  if (!busy) refreshState().catch(error => showStatus(`连接状态更新失败：${error.message}`, 'error'));
}, 3000);
