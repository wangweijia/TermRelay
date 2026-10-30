export function connectionView(state, operation = '', failure = '') {
  const configured = !!state.config;
  const direct = state.config?.accessMode === 'direct';
  const external = !direct && state.proxyMode === 'zeroomega';
  const enabled = !!(direct ? state.directPreviewEnabled : external ? state.externalPreviewEnabled : state.proxyEnabled);
  const blocked = !direct && !external && state.levelOfControl
    && !['controllable_by_this_extension', 'controlled_by_this_extension'].includes(state.levelOfControl);
  const mode = direct ? '直接访问' : external ? 'ZeroOmega 分流' : '内置代理';
  const modeDetail = direct ? '不修改浏览器代理' : external ? '由 ZeroOmega 管理网络分流' : '仅项目主机经开发者电脑转发';
  const problem = failure || state.connectionError || (!direct && !external ? state.proxyError : '');
  let title = configured ? '已关闭' : '尚未配置';
  let detail = configured ? '配置已保存，连接未开启。' : '添加开发者提供的配对配置。';
  let tone = 'idle';
  if (configured && blocked) { title = '代理受限制'; detail = '当前代理由其他扩展或管理员控制。'; tone = 'warning'; }
  if (configured && state.connected && !enabled && !blocked) { title = '已连接，未开启'; detail = 'App 已连接，项目预览尚未开启。'; tone = 'ready'; }
  if (configured && enabled) {
    title = state.connected ? '已开启' : '连接已断开';
    detail = state.connected ? external ? '反馈服务已连接，ZeroOmega 分流待验证。' : '反馈服务已连接。'
      : '尚未确认 App 连接，请重新连接。';
    tone = state.connected ? external ? 'warning' : 'success' : 'warning';
  }
  if (configured && blocked) { title = '代理受限制'; detail = '当前代理由其他扩展或管理员控制。'; tone = 'warning'; }
  if (problem) { title = '连接异常'; detail = problem; tone = 'error'; }
  if (operation || state.connecting) {
    title = operation || '连接中';
    detail = operation === '关闭中' ? '正在关闭预览并释放连接…' : operation === '打开中' ? '正在打开项目…'
      : operation === '检查连接中' ? '正在确认开发者 App 是否在线…' : operation === '读取状态中' ? '正在读取当前配置…' : '正在与开发者 App 建立连接…';
    tone = 'pending';
  }
  return { configured, direct, external, enabled, blocked, mode, modeDetail, title, detail, tone,
    usable: enabled && state.connected && !problem && !blocked };
}