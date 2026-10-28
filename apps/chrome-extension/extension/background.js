const HOST = 'page-gateway-local.nioint.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedPage = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === HOST; }
  catch { return false; }
};
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('配对配置必须是 App 复制的 JSON 对象。');
  const url = new URL(config.companionURL);
  const host = url.hostname;
  const privateHost = host === '127.0.0.1' || host === 'localhost'
    || /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol !== 'http:' || !privateHost || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || !/^[0-9a-f]{64}$/.test(config.reviewerToken) || !/^[0-9a-f]{64}$/.test(config.proxyToken)) {
    throw new Error('请输入内网 HTTP 服务根地址及 64 位配对 Token，不要填写项目 HTTPS 地址。');
  }
  return { companionURL: url.origin, reviewerToken: config.reviewerToken, proxyToken: config.proxyToken };
}
async function configOf() {
  const { config } = await chrome.storage.local.get('config');
  if (!config) throw new Error('请先从扩展设置配对开发者环境。');
  return validateConfig(config);
}
async function request(path, body) {
  const config = await configOf();
  const response = await fetch(`${config.companionURL}${path}`, {
    headers: { Authorization: `Bearer ${config.reviewerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
async function setProxy(enabled) {
  const effective = await chrome.proxy.settings.get({ incognito: false });
  if (enabled && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(effective.levelOfControl)) {
    throw new Error('Chrome 代理被管理员或其他插件控制，未修改设置。');
  }
  if (!enabled) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await chrome.storage.local.set({ proxyEnabled: false });
    return;
  }
  const config = await configOf();
  const url = new URL(config.companionURL);
  const proxy = `${url.hostname}:${url.port || 80}`;
  const data = `function FindProxyForURL(url, host) { if (host === ${JSON.stringify(HOST)}) return ${JSON.stringify(`PROXY ${proxy}`)}; return "DIRECT"; }`;
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data, mandatory: true } }, scope: 'regular' });
  await chrome.storage.local.set({ proxyEnabled: true });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    await storageReady;
    const options = sender.url === chrome.runtime.getURL('options.html');
    if (options) {
      if (message.type === 'settings.get') {
        const values = await chrome.storage.local.get(['config', 'proxyEnabled']);
        const effective = await chrome.proxy.settings.get({ incognito: false });
        return { ...values, levelOfControl: effective.levelOfControl };
      }
      if (message.type === 'settings.save') {
        const config = validateConfig(message.config);
        const { proxyEnabled } = await chrome.storage.local.get('proxyEnabled');
        if (proxyEnabled) await setProxy(false);
        await chrome.storage.local.set({ config });
        return { saved: true };
      }
      if (message.type === 'proxy.set') {
        await setProxy(message.enabled === true);
        return { enabled: message.enabled === true };
      }
      if (message.type === 'connection.test') return request('/v1/meta');
    }
    if (!sender.tab || !allowedPage(sender.url) || sender.frameId !== 0) throw new Error('只允许授权预览页面提交反馈。');
    const meta = await request('/v1/meta');
    const page = new URL(sender.url);
    if (message.type === 'preview.meta') return meta;
    if (message.type === 'feedback.list') {
      const records = await request('/v1/feedback');
      return records.filter(record => record.page.startsWith(`${page.origin}/`));
    }
    if (message.type === 'feedback.create') {
      const target = new URL(message.feedback.page);
      if (target.origin !== page.origin) throw new Error('反馈页面与当前环境不匹配。');
      return request('/v1/feedback', message.feedback);
    }
    if (message.type === 'feedback.verify' && UUID.test(message.id)) {
      return request(`/v1/feedback/${message.id}/verify`, { status: message.status, note: message.note });
    }
    throw new Error('不支持的插件操作。');
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  (async () => {
    if (!details.isProxy || !allowedPage(details.url)) return {};
    const config = await configOf();
    const proxy = new URL(config.companionURL);
    if (details.challenger.host !== proxy.hostname || details.challenger.port !== Number(proxy.port || 80)) return {};
    return { authCredentials: { username: 'preview', password: config.proxyToken } };
  })().then(callback, () => callback({ cancel: true }));
}, { urls: [`https://${HOST}/*`] }, ['asyncBlocking']);

chrome.proxy.onProxyError.addListener(error => console.error('TermRelay preview proxy:', error.error, error.details));
chrome.action.onClicked.addListener(async tab => {
  if (allowedPage(tab.url)) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'panel.toggle' }); }
    catch { await chrome.runtime.openOptionsPage(); }
  } else await chrome.runtime.openOptionsPage();
});
