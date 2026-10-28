const HOST = 'page-gateway-local.nioint.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedPage = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === HOST; }
  catch { return false; }
};
const HEARTBEAT = 'termrelay-app-heartbeat';
const storageReady = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { clientId } = await chrome.storage.local.get('clientId');
  if (!clientId) await chrome.storage.local.set({ clientId: crypto.randomUUID() });
})();
let connecting;

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
async function fetchJSON(config, path, body, connection) {
  const response = await fetch(`${config.companionURL}${path}`, {
    headers: { Authorization: `Bearer ${config.reviewerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(connection ? { 'X-TermRelay-Client-ID': connection.clientId, 'X-TermRelay-Connection-Token': connection.connectionToken } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
async function connectApp(explicit = false) {
  await storageReady;
  if (explicit) await chrome.storage.local.set({ connectionEnabled: true });
  const { connectionEnabled } = await chrome.storage.local.get('connectionEnabled');
  if (connectionEnabled !== true) throw new Error('尚未连接 App，请在点点改设置中粘贴配置并连接，或点击“开启预览”。');
  if (connecting) return connecting;
  connecting = (async () => {
    await storageReady;
    const config = await configOf();
    const { clientId } = await chrome.storage.local.get('clientId');
    const connection = await fetchJSON(config, '/v1/connect', { clientId, proxyToken: config.proxyToken });
    if (connection.clientId !== clientId || !/^[0-9a-f]{64}$/.test(connection.connectionToken)
      || !/^[0-9a-f]{64}$/.test(connection.proxyToken)) throw new Error('App 返回的插件连接无效。');
    await chrome.storage.local.set({ connection, connectionError: '' });
    await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
    return { config, connection };
  })();
  try { return await connecting; }
  finally { connecting = undefined; }
}
async function request(path, body) {
  const { config, connection } = await connectApp();
  return fetchJSON(config, path, body, connection);
}
async function disconnectApp() {
  await chrome.storage.local.set({ connectionEnabled: false });
  if (connecting) await connecting;
  const config = await configOf();
  const { connection } = await chrome.storage.local.get('connection');
  await setProxy(false);
  try {
    if (connection) await fetchJSON(config, '/v1/disconnect', {}, connection);
  } finally {
    await chrome.storage.local.remove('connection');
    await chrome.alarms.clear(HEARTBEAT);
  }
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
  await connectApp(true);
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
        const values = await chrome.storage.local.get(['config', 'proxyEnabled', 'connection', 'connectionError']);
        const effective = await chrome.proxy.settings.get({ incognito: false });
        return { config: values.config, proxyEnabled: values.proxyEnabled, connected: !!values.connection && !values.connectionError,
          connectionError: values.connectionError, levelOfControl: effective.levelOfControl };
      }
      if (message.type === 'settings.save') {
        const config = validateConfig(message.config);
        const { config: prior } = await chrome.storage.local.get('config');
        if (prior) await disconnectApp();
        await chrome.storage.local.set({ config, connectionEnabled: false });
        return { saved: true };
      }
      if (message.type === 'proxy.set') {
        await setProxy(message.enabled === true);
        return { enabled: message.enabled === true };
      }
      if (message.type === 'connection.test') {
        await connectApp(true);
        return request('/v1/meta');
      }
      if (message.type === 'connection.disconnect') {
        await disconnectApp();
        return { disconnected: true };
      }
    }
    if (!sender.tab || !allowedPage(sender.url) || sender.frameId !== 0) throw new Error('只允许在授权预览页面使用点点改。');
    const meta = await request('/v1/meta');
    const page = new URL(sender.url);
    if (message.type === 'preview.meta') return meta;
    if (message.type === 'feedback.list') {
      const records = await request('/v1/feedback');
      return records.filter(record => record.page.startsWith(`${page.origin}/`));
    }
    if (message.type === 'feedback.create') {
      const target = new URL(message.feedback.page);
      if (target.origin !== page.origin) throw new Error('这个想法对应的页面与当前环境不匹配。');
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
    const { config, connection } = await connectApp();
    const proxy = new URL(config.companionURL);
    if (details.challenger.host !== proxy.hostname || details.challenger.port !== Number(proxy.port || 80)) return {};
    return { authCredentials: { username: 'preview', password: connection.proxyToken } };
  })().then(callback, () => callback({ cancel: true }));
}, { urls: [`https://${HOST}/*`] }, ['asyncBlocking']);

chrome.proxy.onProxyError.addListener(error => console.error('TermRelay preview proxy:', error.error, error.details));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== HEARTBEAT) return;
  request('/v1/meta').catch(async error => {
    console.error('TermRelay App heartbeat:', error.message);
    await chrome.storage.local.set({ connectionError: error.message });
  });
});
chrome.action.onClicked.addListener(async tab => {
  if (allowedPage(tab.url)) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'panel.toggle' }); }
    catch { await chrome.runtime.openOptionsPage(); }
  } else await chrome.runtime.openOptionsPage();
});
