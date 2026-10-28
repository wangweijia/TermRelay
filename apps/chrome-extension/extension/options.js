const $ = selector => document.querySelector(selector);
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || '插件后台未响应。');
  return reply.data;
}
async function run(action) {
  try { $('#status').textContent = JSON.stringify(await action(), null, 2); }
  catch (error) { $('#status').textContent = error.message; }
}
$('#settings').onsubmit = event => {
  event.preventDefault();
  run(() => send({ type: 'settings.save', config: {
    companionURL: $('#url').value.trim(), reviewerToken: $('#reviewer').value.trim(), proxyToken: $('#proxy').value.trim(),
  } }));
};
$('#test').onclick = () => run(() => send({ type: 'connection.test' }));
$('#import').onclick = () => run(async () => {
  let config;
  try { config = JSON.parse($('#import-config').value); }
  catch { throw new Error('配对配置不是有效的 JSON，请从 App 重新复制。'); }
  await send({ type: 'settings.save', config });
  $('#url').value = config.companionURL;
  $('#reviewer').value = config.reviewerToken;
  $('#proxy').value = config.proxyToken;
  $('#import-config').value = '';
  return { saved: true, message: '配对已导入，请测试连接；代理仍需单独确认启用。' };
});
$('#enable').onclick = () => run(async () => {
  if (!$('#consent').checked) throw new Error('请先确认代理使用范围与切换注意事项。');
  return send({ type: 'proxy.set', enabled: true });
});
$('#disable').onclick = () => run(() => send({ type: 'proxy.set', enabled: false }));
run(async () => {
  const state = await send({ type: 'settings.get' });
  $('#url').value = state.config?.companionURL || 'http://127.0.0.1:18420';
  $('#reviewer').value = state.config?.reviewerToken || '';
  $('#proxy').value = state.config?.proxyToken || '';
  return { proxyEnabled: state.proxyEnabled === true, levelOfControl: state.levelOfControl };
});
