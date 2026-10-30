const HOST = 'page-gateway-local.nioint.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectOf = config => ({ url: new URL(config.previewURL || `https://${HOST}:8080/`), accessMode: config.accessMode || 'proxy' });
const allowedPage = (value, config) => {
  try {
    const url = new URL(value), project = projectOf(config);
    return ['http:', 'https:'].includes(url.protocol) && (project.accessMode === 'direct'
      ? url.origin === project.url.origin : url.protocol === project.url.protocol && url.hostname === project.url.hostname);
  }
  catch { return false; }
};
const pagePattern = config => { const { url } = projectOf(config); return `${url.protocol}//${url.hostname}/*`; };
function verifyProjectMeta(config, meta) {
  const project = projectOf(config);
  if (meta.preview ? new URL(meta.preview.url).href !== project.url.href || meta.preview.accessMode !== project.accessMode : !!config.previewURL) {
    throw new Error('项目分享地址或访问方式已变化，请重新导入 App 配对配置。');
  }
}
async function registerPage(config) {
  const id = 'termrelay-project-feedback';
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  const matches = [pagePattern(config)];
  if (await chrome.permissions.contains({ origins: matches })) {
    await chrome.scripting.registerContentScripts([{ id, matches, js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  }
}
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
  const result = { companionURL: url.origin, reviewerToken: config.reviewerToken, proxyToken: config.proxyToken };
  if (config.previewURL !== undefined || config.accessMode !== undefined) {
    let project;
    try { project = new URL(config.previewURL); } catch { throw new Error('项目地址无效，请重新复制 App 的配对配置。'); }
    if (!['http:', 'https:'].includes(project.protocol) || project.username || project.password || project.search || project.hash
      || Number(project.port || (project.protocol === 'https:' ? 443 : 80)) < 1
      || project.hostname === 'localhost' || project.hostname.startsWith('127.') || project.hostname === '[::1]'
      || !['direct', 'proxy'].includes(config.accessMode) || (config.accessMode === 'proxy' && project.hostname.includes(':'))) {
      throw new Error('请使用 App 提供的 HTTP / HTTPS 项目地址与访问方式，不要使用 localhost 或带凭据的地址。');
    }
    Object.assign(result, { previewURL: project.href, accessMode: config.accessMode });
  }
  return result;
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
  catch (error) {
    await chrome.storage.local.set({ connectionError: error.message });
    throw error;
  }
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
    await chrome.storage.local.set({ connectionError: '' });
    await chrome.alarms.clear(HEARTBEAT);
  }
}
async function proxyModeOf() {
  const { proxyMode = 'builtin' } = await chrome.storage.local.get('proxyMode');
  if (!['builtin', 'zeroomega'].includes(proxyMode)) throw new Error('代理模式无效，请重新选择代理方式。');
  return proxyMode;
}
async function setProxyMode(mode) {
  if (!['builtin', 'zeroomega'].includes(mode)) throw new Error('请选择插件内置代理或 ZeroOmega 分流。');
  if (mode === await proxyModeOf()) return;
  await setProxy(false);
  await chrome.storage.local.set({ proxyMode: mode, previewConsent: false });
}
async function setProxy(enabled) {
  if (!enabled) {
    const { proxyEnabled } = await chrome.storage.local.get('proxyEnabled');
    if (proxyEnabled) await chrome.proxy.settings.clear({ scope: 'regular' });
    await chrome.storage.local.set({ proxyEnabled: false, externalPreviewEnabled: false, directPreviewEnabled: false, proxyError: '' });
    return;
  }
  const config = await configOf();
  if (projectOf(config).accessMode === 'direct') {
    await connectApp(true);
    await chrome.storage.local.set({ directPreviewEnabled: true, proxyEnabled: false, externalPreviewEnabled: false, proxyError: '' });
    return;
  }
  const mode = await proxyModeOf();
  if (mode === 'builtin') {
    const effective = await chrome.proxy.settings.get({ incognito: false });
    if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(effective.levelOfControl)) {
      throw new Error('Chrome 代理被管理员或其他插件控制，未修改设置。可改用 ZeroOmega 分流，或先在其他插件中释放代理控制。');
    }
  }
  await connectApp(true);
  if (mode === 'zeroomega') {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await chrome.storage.local.set({ proxyEnabled: false, externalPreviewEnabled: true, proxyError: '' });
    return;
  }
  const url = new URL(config.companionURL);
  const proxy = `${url.hostname}:${url.port || 80}`;
  const data = `function FindProxyForURL(url, host) { if (host === ${JSON.stringify(projectOf(config).url.hostname)}) return ${JSON.stringify(`PROXY ${proxy}`)}; return "DIRECT"; }`;
  await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data, mandatory: true } }, scope: 'regular' });
  await chrome.storage.local.set({ proxyEnabled: true, externalPreviewEnabled: false, proxyError: '' });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    await storageReady;
    const options = ['options.html', 'popup.html'].some(path => sender.url === chrome.runtime.getURL(path));
    if (options) {
      if (message.type === 'settings.get') {
        const values = await chrome.storage.local.get(['config', 'proxyEnabled', 'externalPreviewEnabled', 'directPreviewEnabled', 'proxyError', 'connection', 'connectionError', 'connectionEnabled', 'previewConsent']);
        const effective = await chrome.proxy.settings.get({ incognito: false });
        const connected = !!values.connection && values.connectionEnabled !== false && !values.connectionError
          && (!values.connection.expiresAt || values.connection.expiresAt > Date.now());
        return { config: values.config, proxyEnabled: values.proxyEnabled, connected, connecting: !!connecting,
          externalPreviewEnabled: values.externalPreviewEnabled, directPreviewEnabled: values.directPreviewEnabled, previewConsent: values.previewConsent, proxyMode: await proxyModeOf(),
          proxyError: values.proxyError, connectionError: values.connectionError, levelOfControl: effective.levelOfControl };
      }
      if (message.type === 'proxy.mode') {
        await setProxyMode(message.mode);
        return { mode: message.mode };
      }
      if (message.type === 'settings.save') {
        const config = validateConfig(message.config);
        const { config: prior } = await chrome.storage.local.get('config');
        if (prior) await disconnectApp();
        await chrome.storage.local.set({ config, connectionEnabled: false, previewConsent: false });
        await registerPage(config);
        return { saved: true };
      }
      if (message.type === 'preview.authorize') {
        const config = await configOf();
        if (!await chrome.permissions.contains({ origins: [pagePattern(config)] })) throw new Error('请允许点点改访问本次项目站点。');
        await registerPage(config);
        return { authorized: true };
      }
      if (message.type === 'proxy.set') {
        await setProxy(message.enabled === true);
        if (message.enabled === true && message.consent === true) await chrome.storage.local.set({ previewConsent: true });
        return { enabled: message.enabled === true };
      }
      if (message.type === 'connection.test') {
        try {
          await connectApp(true);
          const meta = await request('/v1/meta');
          const config = await configOf();
          verifyProjectMeta(config, meta);
          return meta;
        } catch (error) {
          await chrome.storage.local.set({ connectionError: error.message });
          throw error;
        }
      }
      if (message.type === 'connection.status') {
        const { connection, connectionEnabled } = await chrome.storage.local.get(['connection', 'connectionEnabled']);
        if (!connection || connectionEnabled !== true) return { checked: false };
        const isCurrent = async () => {
          const current = await chrome.storage.local.get(['connection', 'connectionEnabled']);
          return current.connectionEnabled === true && current.connection?.connectionToken === connection.connectionToken;
        };
        try {
          const config = await configOf();
          const meta = await fetchJSON(config, '/v1/meta', undefined, connection);
          if (!await isCurrent()) return { checked: false };
          verifyProjectMeta(config, meta);
          await chrome.storage.local.set({ connection: { ...connection, expiresAt: Date.now() + 90_000 }, connectionError: '' });
          return { checked: true };
        } catch (error) {
          if (!await isCurrent()) return { checked: false };
          await chrome.storage.local.set({ connectionError: error.message });
          return { checked: true, error: error.message };
        }
      }
      if (message.type === 'connection.disconnect') {
        await disconnectApp();
        return { disconnected: true };
      }
    }
    const config = await configOf();
    if (!sender.tab || !allowedPage(sender.url, config) || sender.frameId !== 0) throw new Error('只允许在授权预览页面使用点点改。');
    const meta = await request('/v1/meta');
    verifyProjectMeta(config, meta);
    const page = new URL(sender.url);
    if (message.type === 'feedback.id') return crypto.randomUUID();
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
    if (!details.isProxy) return {};
    const config = await configOf();
    const project = projectOf(config), target = new URL(details.url);
    if (project.accessMode === 'direct' || !['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)
      || target.hostname !== project.url.hostname) return {};
    const proxy = new URL(config.companionURL);
    if (details.challenger.host !== proxy.hostname || details.challenger.port !== Number(proxy.port || 80)) return {};
    const { connection } = await connectApp();
    return { authCredentials: { username: 'preview', password: connection.proxyToken } };
  })().then(callback, () => callback({ cancel: true }));
}, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, ['asyncBlocking']);

chrome.proxy.onProxyError.addListener(error => {
  (async () => {
    await storageReady;
    if (projectOf(await configOf()).accessMode === 'direct' || await proxyModeOf() !== 'builtin') return;
    const { proxyEnabled } = await chrome.storage.local.get('proxyEnabled');
    if (!proxyEnabled) return;
    const effective = await chrome.proxy.settings.get({ incognito: false });
    if (effective.levelOfControl !== 'controlled_by_this_extension') return;
    console.error('TermRelay built-in preview proxy:', error.error);
    await chrome.storage.local.set({ proxyError: error.error });
  })().catch(error => console.error('TermRelay proxy error reporting failed:', error.message));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== HEARTBEAT) return;
  request('/v1/meta').catch(async error => {
    const { connectionEnabled } = await chrome.storage.local.get('connectionEnabled');
    if (!connectionEnabled) return;
    console.error('TermRelay App heartbeat:', error.message);
    await chrome.storage.local.set({ connectionError: error.message });
  });
});
