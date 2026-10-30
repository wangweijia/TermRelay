import { connectionView } from './view-state.js';

const $ = selector => document.querySelector(selector);
let state = {}, busy = true, operation = '', failure = '', context = '';
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || '插件后台未响应。');
  return reply.data;
}
function render() {
  const view = connectionView(state, operation);
  const entry = state.config?.previewURL;
  $('#mode').textContent = view.configured ? view.mode : '待配置';
  $('#project-title').textContent = entry ? new URL(entry).hostname : view.configured ? 'page-gateway-local.nioint.com' : '尚未添加项目';
  $('#project-url').textContent = entry || '';
  $('#connection-state').dataset.tone = view.tone;
  $('#state-title').textContent = view.title;
  $('#state-detail').textContent = view.detail;
  $('#power').checked = view.enabled;
  $('#power').disabled = busy || !view.configured || (!view.enabled && (view.blocked || (!view.direct && !state.previewConsent && !$('#consent').checked)));
  $('#power-label').textContent = operation || (view.enabled ? '已开启' : '已关闭');
  $('#consent-row').hidden = !view.configured || view.direct || !!state.previewConsent || view.enabled;
  $('#consent').disabled = busy;
  $('#consent-label').textContent = view.external ? '我已配置 ZeroOmega 分流规则，并保留原有规则。'
    : '我使用独立 Chrome 用户配置，允许项目主机经开发者电脑转发、其他主机直连。代理凭据可访问开发者本机全部 TCP 端口。';
  $('#open-project').disabled = busy || !view.usable;
  $('#configure').disabled = busy && !!operation;
  $('#connection-label').textContent = state.connecting || operation === '连接中' ? 'App 连接中' : state.connected ? 'App 已连接' : 'App 未连接';
  $('#message').hidden = !failure;
  $('#message').textContent = failure;
  $('main').setAttribute('aria-busy', String(busy));
}
async function refresh() {
  const next = await send({ type: 'settings.get' });
  const nextContext = JSON.stringify([next.config, next.proxyMode]);
  if (nextContext !== context || (state.previewConsent && !next.previewConsent)) { $('#consent').checked = false; failure = ''; context = nextContext; }
  state = next;
  render();
}
async function run(action, title) {
  if (busy) return;
  busy = true; operation = title; failure = ''; render();
  try { await action(); }
  catch (error) { failure = error.message; }
  finally {
    try { await refresh(); } catch (error) { failure = error.message; }
    busy = false; operation = ''; render();
  }
}
$('#consent').onchange = render;
$('#configure').onclick = () => chrome.runtime.openOptionsPage().catch(error => { failure = error.message; render(); });
$('#power').onchange = () => {
  if (busy) return;
  if (!$('#power').checked) {
    run(() => send({ type: 'connection.disconnect' }), '关闭中');
    return;
  }
  const url = new URL(state.config.previewURL || 'https://page-gateway-local.nioint.com/');
  const authorization = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  authorization.catch(() => {});
  run(async () => {
    if (!await authorization) throw new Error('请允许访问项目站点，以启用页面反馈。');
    await send({ type: 'preview.authorize' });
    await send({ type: 'connection.test' });
    await send({ type: 'proxy.set', enabled: true, consent: $('#consent').checked });
  }, '连接中');
};
$('#open-project').onclick = () => run(async () => {
  const meta = await send({ type: 'connection.test' });
  const entry = meta.previewURLs?.[0] || state.config.previewURL
    || (meta.ports?.[0] ? `https://page-gateway-local.nioint.com:${meta.ports[0]}/` : undefined);
  if (!entry || !['http:', 'https:'].includes(new URL(entry).protocol)) throw new Error('项目入口无效，请更新配对配置。');
  await chrome.tabs.create({ url: entry });
}, '打开中');
async function initialize() {
  try {
    await refresh();
    if (state.connected) {
      operation = '检查连接中'; render();
      await send({ type: 'connection.status' });
      await refresh();
    }
  } catch (error) { failure = error.message; }
  finally { busy = false; operation = ''; render(); }
}
initialize();
setInterval(() => { if (!busy) refresh().catch(error => { failure = error.message; render(); }); }, 1500);