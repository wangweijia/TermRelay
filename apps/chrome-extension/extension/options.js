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
  const external = state.proxyMode === 'zeroomega';
  const proxyBlocked = state.levelOfControl && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(state.levelOfControl);
  const previewing = external ? state.externalPreviewEnabled : state.proxyEnabled && state.levelOfControl === 'controlled_by_this_extension';
  badge('#config-badge', configured ? '已保存' : '待配置', configured ? 'success' : '');
  badge('#connection-badge', connected ? '已连接' : '未连接', connected ? 'success' : '');
  badge('#proxy-badge', external ? previewing ? connected ? 'ZeroOmega · 待验证' : '等待 App' : 'ZeroOmega · 未确认'
    : proxyBlocked ? '代理受限制' : previewing ? state.proxyError ? '代理连接异常' : connected ? '已开启' : '等待 App' : '未开启',
  external ? 'warning' : proxyBlocked || (previewing && (!connected || state.proxyError)) ? 'warning' : previewing ? 'success' : '');
  $('#saved-config').hidden = !configured;
  $('#preview-links').hidden = !previewing || !connected;
  $('#saved-address').textContent = state.config?.companionURL || '';
  $('#connection-help').textContent = connectionIssue || state.connectionError ? '连接遇到问题，请确认 Mac 已开启共享，再重新连接。ZeroOmega 用户请确认 Mac 服务地址走直连。'
    : external ? previewing && connected ? 'App 已连接；ZeroOmega 分流尚未验证。打开下方入口，确认页面可以访问。'
      : '按下方方案配置 ZeroOmega，再确认并开启预览。点点改不会接管浏览器代理。'
    : previewing && state.proxyError ? `内置代理报错：${state.proxyError}。请确认 Mac 共享服务与网络可达，再重新开启预览。`
    : previewing && connected ? '一切就绪。打开下方入口，在业务页面点击「点点改」。'
      : connected ? '已连接开发者 Mac。确认使用范围后，开启预览即可访问页面。'
        : configured ? '配置已保存。开启预览时会自动连接 App。' : '先粘贴配置，把浏览器和开发者 Mac 连起来。';
  for (const input of document.querySelectorAll('[name="proxy-mode"]')) input.checked = input.value === state.proxyMode;
  $('#mode-help').textContent = external
    ? '由 ZeroOmega 管理所有分流。切换到此模式会释放点点改自己的代理设置，不修改 ZeroOmega 的配置。'
    : '由点点改接管 Chrome 代理：仅预览域名走开发者 Mac，其余域名直连。其他插件占用代理时无法开启；可切换到 ZeroOmega 模式。';
  $('#zeroomega-setup').hidden = !external;
  $('#zeroomega-unconfigured').hidden = configured;
  $('#zeroomega-configured').hidden = !configured;
  if (configured) {
    const url = new URL(state.config.companionURL);
    const guide = [
      'ZeroOmega 快速配置（不覆盖原有规则）',
      '1. 新建「代理服务器」情景模式，名称：点点改预览',
      '   代理协议：HTTP（用于 HTTPS CONNECT，不是 HTTPS 代理）',
      `   代理服务器：${url.hostname}`,
      `   代理端口：${url.port || 80}`,
      '   用户名、密码：留空；由点点改按当前连接自动认证，请勿填写配对密钥。',
      '2. 在你现有的「自动切换」情景顶部添加以下两条规则：',
      `   主机名通配符：${url.hostname} → 直接连接（Mac 服务与反馈接口）`,
      '   主机名通配符：page-gateway-local.nioint.com → 点点改预览（所有端口）',
      '   保留其余规则与默认情景，不要把默认情景改成「点点改预览」。',
      '3. 点击「应用选项」，在 ZeroOmega 工具栏菜单选择上述「自动切换」情景。',
      '4. 回到点点改，勾选下方确认并开启预览，再打开入口验证页面。',
      '断开点点改后认证会失效；ZeroOmega 规则仍保留，需自行停用或删除。',
    ].join('\n');
    if ($('#zeroomega-guide').value !== guide) $('#zeroomega-guide').value = guide;
  } else $('#zeroomega-guide').value = '';
  $('#consent-label').textContent = external
    ? '我已按方案配置并启用 ZeroOmega 自动切换，保留原有规则；切换环境后会关闭旧页面，再重新打开。'
    : '我确认当前用户配置可以使用上述代理规则；切换环境后会关闭旧页面，再重新打开。';
  $('#disable').hidden = external;
  $('#pause-help').hidden = !external;
  for (const control of document.querySelectorAll('button,input,textarea')) control.disabled = busy;
  $('#enable').disabled = busy || !configured || !$('#consent').checked || (!external && proxyBlocked)
    || (previewing && connected && (external || !state.proxyError));
  $('#enable').textContent = external ? previewing && connected ? '已确认 ZeroOmega 配置' : '使用 ZeroOmega 预览'
    : previewing && connected && !state.proxyError ? '预览已开启' : '开启预览';
  $('#disconnect').disabled = busy || !configured;
  $('#test').disabled = busy || !configured;
  $('#disable').disabled = busy || !state.proxyEnabled;
  $('#import').disabled = busy || !$('#import-config').value.trim();
  $('#copy-zeroomega').disabled = busy || !configured;
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
    link.textContent = `打开预览（端口 ${port}）`;
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
  return state.proxyMode === 'zeroomega' ? '配置已保存，App 连接成功。请按下方方案配置 ZeroOmega，再确认并开启预览。'
    : '配置已保存，App 连接成功。再确认一下使用范围，点击「开启预览」就可以了。';
}
$('#import-config').oninput = render;
$('#consent').onchange = render;
for (const input of document.querySelectorAll('[name="proxy-mode"]')) {
  input.onchange = () => run(async () => {
    await send({ type: 'proxy.mode', mode: input.value });
    $('#consent').checked = false;
    return input.value === 'zeroomega'
      ? '已切换到 ZeroOmega，点点改已释放自己的代理设置。请按方案配置分流，再确认开启。'
      : '已切换到插件内置代理，尚未接管 Chrome。请先让 ZeroOmega 释放代理控制，再确认开启。';
  }, '正在切换代理方式…');
}
$('#copy-zeroomega').onclick = () => run(async () => {
  await navigator.clipboard.writeText($('#zeroomega-guide').value);
  return 'ZeroOmega 配置方案已复制，不含配对密钥。请按步骤新增规则，不要覆盖现有配置。';
}, '正在复制配置方案…');
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
  return state.proxyMode === 'zeroomega'
    ? 'App 已连接，分流由 ZeroOmega 管理；尚未验证规则是否生效。请打开预览入口验证，旧标签页请关闭后重新打开。'
    : '预览已开启。打开预览链接，进入业务页面后点击「点点改」。旧预览标签页请关闭后重新打开。';
}, '正在连接并开启预览…');
$('#test').onclick = () => run(async () => { await connect(); return 'App 连接正常，可以继续预览与提交想法。'; }, '正在检查 App 连接…');
$('#disconnect').onclick = () => run(async () => {
  await send({ type: 'connection.disconnect' });
  connectionIssue = false;
  return state.proxyMode === 'zeroomega'
    ? '已结束连接，撤销本次代理认证并关闭已有预览隧道。ZeroOmega 配置未修改，请按需停用预览规则；其他验收者现在可以接入。'
    : '已结束连接并关闭代理。其他验收者现在可以接入；已经提交的改动任务不会因此取消。';
}, '正在结束连接…');
$('#disable').onclick = () => run(async () => {
  await send({ type: 'proxy.set', enabled: false });
  return '页面代理已暂停，App 连接仍保留。如需让其他验收者接入，请点击「结束本次连接」。';
}, '正在暂停预览代理…');
async function initialize() {
  try {
    await refreshState();
    fillManualFields();
    $('#consent').checked = state.proxyMode === 'zeroomega' ? !!state.externalPreviewEnabled : !!state.proxyEnabled;
    if (state.connected) await connect();
  } catch (error) { showStatus(`暂时无法读取或连接环境：${error.message}`, 'error'); }
  finally { busy = false; render(); }
}
initialize();
setInterval(() => {
  if (!busy) refreshState().catch(error => showStatus(`连接状态更新失败：${error.message}`, 'error'));
}, 3000);
