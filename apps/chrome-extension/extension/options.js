import { connectionView } from './view-state.js';

const $ = selector => document.querySelector(selector);
let state = {}, meta, busy = true, connectionIssue = false, operation = '读取状态中';
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
  const direct = state.config?.accessMode === 'direct';
  const external = !direct && state.proxyMode === 'zeroomega';
  const proxyBlocked = state.levelOfControl && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(state.levelOfControl);
  const previewing = direct ? state.directPreviewEnabled : external ? state.externalPreviewEnabled : state.proxyEnabled && state.levelOfControl === 'controlled_by_this_extension';
  const view = connectionView({ ...state, connected }, operation, connectionIssue ? '连接未确认，请重新连接。' : '');
  $('#current-project').textContent = configured ? state.config.previewURL ? new URL(state.config.previewURL).hostname : meta?.name || '项目预览' : '尚未添加项目';
  $('#active-mode').textContent = configured ? view.mode : '待配置';
  $('#active-mode').dataset.mode = direct ? 'direct' : external ? 'external' : 'builtin';
  $('#active-mode-detail').textContent = configured ? view.modeDetail : '';
  $('#session-status').textContent = view.title;
  $('#session-state').dataset.tone = view.tone;
  $('#access-controls').hidden = !configured;
  $('#pairing-title').textContent = configured ? '更换配对配置' : '添加配对配置';
  if (!configured) $('#pairing').open = true;
  badge('#config-badge', configured ? '已保存' : '待配置', configured ? 'success' : '');
  badge('#connection-badge', connected ? '已连接' : '未连接', connected ? 'success' : '');
  badge('#proxy-badge', direct ? '直接访问 · 不使用代理' : external ? previewing ? connected ? 'ZeroOmega · 待验证' : '等待 App' : 'ZeroOmega · 未确认'
    : proxyBlocked ? '代理受限制' : previewing ? state.proxyError ? '代理连接异常' : connected ? '已开启' : '等待 App' : '未开启',
  direct ? 'success' : external ? 'warning' : proxyBlocked || (previewing && (!connected || state.proxyError)) ? 'warning' : previewing ? 'success' : '');
  $('#saved-config').hidden = !configured;
  $('#preview-links').hidden = !previewing || !connected;
  $('#saved-address').textContent = state.config?.companionURL || '';
  $('#project-config').hidden = !configured;
  $('#project-address').textContent = state.config?.previewURL || (configured ? '旧版域名预览配置' : '');
  $('#profile-guide').hidden = !configured || direct;
  $('#proxy-consent').hidden = direct;
  $('.proxy-modes').hidden = direct;
  $('#mode-help').hidden = direct;
  $('#access-warning').textContent = direct
    ? '仅向可信验收者分享。页面内容与反馈通过开发者共享的局域网服务提交。'
    : '仅限受信局域网。项目代理主机可连接开发者 Mac 的所有本地 TCP 端口；仅向可信验收者分享，不绕过公司网络管理策略。';
  $('#connection-help').textContent = connectionIssue || state.connectionError ? '连接遇到问题，请确认开发者 Mac 已开启共享且局域网可达，再重新连接。'
    : direct ? connected ? '已连接开发者 Mac。点击“打开项目”即可访问并提交反馈，不修改浏览器代理。' : '直接访问项目；打开项目时会自动连接反馈服务。'
    : external ? previewing && connected ? 'App 已连接；ZeroOmega 分流尚未验证。打开下方入口，确认页面可以访问。'
      : '按高级设置中的方案配置 ZeroOmega，再确认并打开预览。点点改不会接管浏览器代理。'
    : previewing && state.proxyError ? `内置代理报错：${state.proxyError}。请确认 Mac 共享服务与网络可达，再重新开启预览。`
    : previewing && connected ? '一切就绪。打开下方入口，在业务页面点击「点点改」。'
      : connected ? '已连接开发者 Mac。确认专用用户配置后，点击“打开预览”。'
        : configured ? '配置已保存。打开预览时会自动连接 App。' : '先粘贴开发者发来的配对配置。';
  $('#preview-help').textContent = direct ? '直接打开 App 配置的项目地址。首次打开时授权该站点以启用反馈；无需专用 Chrome 用户配置，原代理规则保持不变。' : external
    ? '当前使用 ZeroOmega 分流。配置方案在高级设置中，确认规则后打开预览。'
    : proxyBlocked ? '当前代理由其他扩展或管理员控制，点点改不会接管。请在验收专用用户配置中使用；确需 ZeroOmega 时，在高级设置中切换。'
      : '使用内置代理，无需配置分流规则。点击后自动连接并打开项目；结束连接时关闭本插件代理。';
  for (const input of document.querySelectorAll('[name="proxy-mode"]')) input.checked = input.value === state.proxyMode;
  $('#mode-help').textContent = external
    ? '由 ZeroOmega 管理所有分流。切换到此模式会释放点点改自己的代理设置，不修改 ZeroOmega 的配置。'
    : '仅接管当前 Chrome 用户配置的代理，不合并公司代理规则。请使用独立的验收用户配置；日常用户配置不受影响。';
  $('#zeroomega-setup').hidden = !external;
  $('#zeroomega-unconfigured').hidden = configured;
  $('#zeroomega-configured').hidden = !configured;
  if (configured) {
    const url = new URL(state.config.companionURL);
    const guide = [
      'ZeroOmega 快速配置（不覆盖原有规则）',
      '1. 新建「代理服务器」情景模式，名称：点点改预览',
      '   代理协议：HTTP（支持 HTTP 转发与 HTTPS CONNECT）',
      `   代理服务器：${url.hostname}`,
      `   代理端口：${url.port || 80}`,
      '   用户名、密码：留空；由点点改按当前连接自动认证，请勿填写配对密钥。',
      '2. 在你现有的「自动切换」情景顶部添加以下两条规则：',
      `   主机名通配符：${url.hostname} → 直接连接（Mac 服务与反馈接口）`,
      `   主机名通配符：${new URL(state.config.previewURL || 'https://page-gateway-local.nioint.com/').hostname} → 点点改预览（所有端口）`,
      '   保留其余规则与默认情景，不要把默认情景改成「点点改预览」。',
      '3. 点击「应用选项」，在 ZeroOmega 工具栏菜单选择上述「自动切换」情景。',
      '4. 回到点点改，在上方“页面预览”勾选确认，点击“使用 ZeroOmega 打开预览”验证页面。',
      '断开点点改后认证会失效；ZeroOmega 规则仍保留，需自行停用或删除。',
    ].join('\n');
    if ($('#zeroomega-guide').value !== guide) $('#zeroomega-guide').value = guide;
  } else $('#zeroomega-guide').value = '';
  $('#consent-label').textContent = external
    ? '我已按方案配置并启用 ZeroOmega 自动切换，保留原有规则；切换环境后会关闭旧页面，再重新打开。'
    : '我确认正在使用验收专用 Chrome 用户配置，允许预览域名走开发者 Mac、其他域名直连；切换环境后关闭旧预览页面。';
  $('#disable').hidden = direct || external;
  $('#pause-help').hidden = !external;
  for (const control of document.querySelectorAll('button,input,textarea,select')) control.disabled = busy;
  $('#enable').disabled = busy || !configured || (!direct && (!$('#consent').checked || (!external && proxyBlocked)));
  $('#enable').textContent = direct ? '打开项目' : external ? '使用 ZeroOmega 打开预览' : '打开预览';
  $('#disconnect').disabled = busy || !configured;
  $('#test').disabled = busy || !configured;
  $('#disable').disabled = busy || !state.proxyEnabled;
  $('#import').disabled = busy || !$('#import-config').value.trim();
  $('#copy-zeroomega').disabled = busy || !configured;
  $('#connection-help').textContent = view.detail;
  document.querySelector('main').setAttribute('aria-busy', String(busy));
}
function fillManualFields() {
  $('#url').value = state.config?.companionURL || '';
  $('#reviewer').value = state.config?.reviewerToken || '';
  $('#proxy').value = state.config?.proxyToken || '';
  $('#project-url').value = state.config?.previewURL || '';
  $('#access-mode').value = state.config?.accessMode || '';
}
async function refreshState() {
  state = await send({ type: 'settings.get' });
  render();
}
function renderLinks() {
  $('#preview-links').replaceChildren();
  const urls = meta?.previewURLs || (meta?.ports || []).map(port => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('App 返回的预览端口无效，请检查共享设置。');
    return `https://page-gateway-local.nioint.com:${port}/`;
  });
  for (const value of urls) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('App 返回的项目入口无效。');
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `打开项目 · ${url.host}${url.pathname}`;
    $('#preview-links').append(link);
  }
}
async function connect() {
  operation = '连接中'; render();
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
  busy = true; operation = ''; render(); showStatus(progress);
  try { showStatus(await action(), 'success'); }
  catch (error) { showStatus(error.message, 'error'); }
  finally {
    try { await refreshState(); }
    catch (error) { showStatus(`无法更新连接状态：${error.message}`, 'error'); }
    busy = false; operation = ''; render();
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
  $('#pairing').open = false;
  try { await connect(); }
  catch (error) { throw new Error(`配置已保存，但暂时连不上 App：${error.message}`); }
  return state.config?.accessMode === 'direct' ? '配置已保存，App 连接成功。点击“打开项目”即可；无需修改浏览器代理。'
    : state.proxyMode === 'zeroomega' ? '配置已保存，App 连接成功。请按高级设置中的方案配置 ZeroOmega，再确认并打开预览。'
    : '配置已保存，App 连接成功。确认正在使用验收专用用户配置，点击“打开预览”即可。';
}
$('#import-config').oninput = render;
$('#consent').onchange = render;
for (const input of document.querySelectorAll('[name="proxy-mode"]')) {
  input.onchange = () => run(async () => {
    await send({ type: 'proxy.mode', mode: input.value });
    $('#consent').checked = false;
    return input.value === 'zeroomega'
      ? '已切换到 ZeroOmega，点点改已释放自己的代理设置。请按方案配置分流，再确认开启。'
      : '已切换到内置代理，尚未接管 Chrome。请确认正在使用验收专用用户配置，再打开预览。';
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
    ...($('#project-url').value.trim() || $('#access-mode').value
      ? { previewURL: $('#project-url').value.trim(), accessMode: $('#access-mode').value } : {}),
  }), '正在保存配置并连接开发者 Mac…');
};
$('#enable').onclick = () => {
  if (busy || $('#enable').disabled) return;
  const url = new URL(state.config.previewURL || 'https://page-gateway-local.nioint.com/');
  const authorization = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  authorization.catch(() => {});
  run(async () => {
  if (state.config?.accessMode !== 'direct' && !$('#consent').checked) throw new Error('请先确认当前 Chrome 用户配置可以使用此预览代理。');
  if (!await authorization) throw new Error('未获得项目站点权限，请再次点击并允许访问，以启用页面反馈。');
  await send({ type: 'preview.authorize' });
  await connect();
  const entry = $('#preview-links a')?.href;
  if (!entry) throw new Error('App 未提供有效的项目入口，请开发者检查共享地址。');
  await send({ type: 'proxy.set', enabled: true, consent: $('#consent').checked });
  try { await chrome.tabs.create({ url: entry }); }
  catch { throw new Error('预览已开启，但未能打开新标签页。请点击上方预览入口重试。'); }
  return state.config?.accessMode === 'direct' ? '已打开项目，反馈服务已连接；浏览器代理设置未修改。在页面点击“点点改”提交反馈。'
    : state.proxyMode === 'zeroomega'
    ? '已打开预览入口，分流由 ZeroOmega 管理；尚未验证规则是否生效。请在页面确认访问效果，并关闭旧预览标签页。'
    : '已开启代理并打开预览。进入业务页面后点击“点点改”提交反馈；旧预览标签页请关闭。';
  }, '正在连接并打开项目…');
};
$('#test').onclick = () => run(async () => { await connect(); return 'App 连接正常，可以继续预览与提交想法。'; }, '正在检查 App 连接…');
$('#disconnect').onclick = () => run(async () => {
  operation = '关闭中'; render();
  await send({ type: 'connection.disconnect' });
  connectionIssue = false;
  return state.config?.accessMode === 'direct' ? '已结束反馈连接，项目的直接访问与原浏览器代理设置不受影响。'
    : state.proxyMode === 'zeroomega'
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
    $('#pairing').open = !state.config;
    $('#consent').checked = !!state.previewConsent || (state.proxyMode === 'zeroomega' ? !!state.externalPreviewEnabled : !!state.proxyEnabled);
    if (state.connected) await connect();
  } catch (error) { showStatus(`暂时无法读取或连接环境：${error.message}`, 'error'); }
  finally { busy = false; operation = ''; render(); }
}
initialize();
setInterval(() => {
  if (!busy) refreshState().catch(error => showStatus(`连接状态更新失败：${error.message}`, 'error'));
}, 3000);
