# Chrome 预览与反馈：进展与待办

> 更新日期：2026-10-30。
> 当前阶段：已从独立 CLI 实验版接入 Mac App 原生 UI，完成合成环境验证，尚未完成真实业务项目端到端验收。
> 使用方法见 [README](README.md)，产品交互与未决策项见 [需求草案](../../docs/CHROME_PREVIEW_FEEDBACK_REQUIREMENTS.md)。

## 1. 当前实现路线

扩展和桥接代码放在 `apps/chrome-extension`，暂未加入根 pnpm workspace；
Mac 原生入口、托管进程与反馈管理已接入 `apps/mac`。
没有修改 TermRelay Server、数据库或协议生成文件。

```text
预览访问：
默认直连：业务方 Chrome -> 项目原 HTTP(S) 地址（已有域名 / 局域网 IP）
可选代理：Chrome 插件 -> 开发者受限 HTTP / CONNECT 代理 -> 127.0.0.1:项目原端口

App 控制：
项目会话 -> 共享预览与反馈 -> 开启共享 / 复制配对 / 查看反馈 / 停止共享

反馈执行：
Chrome 插件 -> App 托管的本机反馈桥接 -> 自动排队等待绑定 Chat 空闲
    -> App 直接启动已有本地普通 ACP 会话，AI 工具审批沿用原策略
    -> App 关联真实轮次并同步开始 / 等待 / 完成状态 -> 业务方验收
```

本机桥接不连接 Server；网页、反馈和验收在受信局域网 / 本机闭环，
由 App 复用本地 ACP 会话能力执行，不调用通用外部 AI API，也不自动创建专用会话。
App 公网配对、Server 断开和地址变更均不影响本功能。
“优先绑定已有会话”已用于本实验版，不代表专用会话等后续产品选项已经定案。
用户不再需要运行 CLI、查 UUID、阅读 Token 文件或打开独立管理页；
旧命令行入口和 Web 管理页只保留作开发诊断。

## 2. 已完成

| 能力 | 已实现范围 | 主要文件 |
| --- | --- | --- |
| 独立项目 | Node.js 22+，无需额外安装依赖，独立启动与检查命令 | `package.json`、`scripts/check.mjs` |
| Chrome 扩展 | Manifest V3、配对设置页、连接测试、扩展图标入口 | `extension/manifest.json`、`options.*`、`background.js` |
| 快捷连接与配置层级 | 工具栏轻量 popup，快速开启 / 关闭、项目入口与独立配置按钮；设置页突出当前项目、实际模式与连接状态，已保存配对默认收起 | `extension/popup.*`、`view-state.js`、`options.*`、`background.js` |
| 点点改与粘贴优先引导 | 配置粘贴即保存并连接，代理仍需明确确认；手填收进高级设置，单列白底界面、文字状态、预览入口与自然语言错误 | `extension/options.*`、`manifest.json` |
| 验收专用 Profile 默认流程 | 明确在验收者电脑创建独立 Profile，不安装 ZeroOmega；确认后“打开预览”自动连接、启用代理并打开首个入口，可重复打开；ZeroOmega 移入高级设置且保留旧模式 | `extension/options.*`、`tests/browser.mjs` |
| 独占插件连接 | 整个 App 一个插件实例，同 Profile 多页面共享；90 秒租约、后台续约、显式断开、动态代理凭据 | `companion/server.mjs`、`proxy.mjs`、`extension/background.js` |
| 项目地址与访问方式 | App 填写完整 HTTP(S) URL，默认直连，也可选择代理；配对带项目地址与方式，旧配置保留原域名兼容 | `PreviewSharingView.swift`、`PreviewSharingController.swift`、`companion/main.mjs` |
| 配置主机代理 | 仅代理本次配置的项目主机，HTTP / WS 转发、HTTPS / WSS CONNECT 均连接开发者本机原端口 | `extension/background.js`、`companion/proxy.mjs` |
| 动态页面授权 | HTTPS 主机按需申请权限，按站点注册反馈脚本；直连精确匹配 origin，代理匹配同协议同主机的合法端口；分享变更提示重新导入 | `extension/background.js`、`options.js`、`manifest.json`、`companion/model.mjs` |
| ZeroOmega 分流模式 | 保留内置 PAC；显式切换并保存模式，生成可复制的无凭据配置方案；外部分流仅维持连接 / 认证 / 反馈，不覆盖原规则 | `extension/options.*`、`background.js` |
| 代理错误归属 | 只在本扩展实际接管内置代理时记录全局代理错误，设置页显示并允许重试；不误报其他扩展的代理错误 | `extension/background.js`、`options.js` |
| 全端口域名转发 | 指定域名所有合法端口按原端口转发，目标固定为本机 loopback；入口端口仅生成链接 | `companion/main.mjs`、`proxy.mjs` |
| 代理访问限制 | Basic 凭据、严格目标域名和合法端口范围；不转发其他域名，但持有凭据者可访问全部本地 TCP 端口 | `companion/proxy.mjs` |
| 点点改页面 UI | 右下角文字按钮、简洁黑白浮层、点选 / 整页、扩大范围、Esc 退出；折叠可选字段、文字进度与“效果满意 / 再调一调” | `extension/content.js` |
| 文字与上下文 | 修改描述、可选复现步骤、有限元素文字及结构线索，提交前查看上下文 | `extension/content.js`、`companion/model.mjs` |
| 基础敏感信息过滤 | 不采集截图、原始 outerHTML、表单值、Cookie、存储；过滤 URL 查询与 hash | `extension/content.js`、`companion/model.mjs` |
| 受限反馈接口 | 提交、列表、验收；反馈 Token 与管理 Token 分离，网页脚本来源被拒绝 | `companion/server.mjs` |
| 本机管理页 | 仅 loopback 监听，查看反馈、核对绑定、填写结果摘要；执行入口仅在 App | `companion/owner.*` |
| 已有会话绑定 | 固定本地设备、工作区和会话；App 拒绝 PTY、外部 AI 对话、已结束 / 忙碌会话 | `companion/main.mjs`、`AppModel.swift` |
| 自动轮次发送 | helper 持久化意图后返回受限提示词和命令 ID；App 自动按序启动本地轮次，不改变 AI 工具审批 | `companion/server.mjs`、`PreviewSharingController.swift` |
| 真实轮次跟踪 | 关联命令 ID 与 Provider 轮次，支持早于命令响应的事件；自动同步运行、等待审批 / 问答及完成 / 失败 | `PreviewSharingController.swift`、`AppModel.swift`、`extension/content.js` |
| 提交与执行去重 | 反馈 UUID 幂等；执行意图先落盘；已经尝试发送的记录不自动重发 | `companion/server.mjs`、`store.mjs` |
| 未知结果保护 | 本地执行结果不确定或发送中重启标记未知；丢失响应时允许人工核实发送中记录，禁止自动重发 | `PreviewSharingController.swift`、`store.mjs`、`server.mjs` |
| 人工验收闭环 | 关联轮次成功完成后自动交业务方验收；业务方选择通过或填写继续修改意见，未知结果由开发者核实 | `PreviewSharingController.swift`、`extension/content.js` |
| 本地持久化 | 私有凭据文件、JSON 反馈记录、单数据目录进程锁、正常停止清理锁 | `companion/main.mjs`、`store.mjs` |
| Mac 会话入口 | 会话顶部打开“共享预览与反馈”，固定绑定此会话，不跟随主窗口切换 | `apps/mac/Sources/AppShell/ContentView.swift`、`PreviewSharingView.swift` |
| 原生共享面板 | “共享与配对 / 页面反馈”页签，端口与本机 IP 配置、启停、显示插件目录、复制配对 JSON | `apps/mac/Sources/AppShell/PreviewSharingView.swift` |
| App 托管服务 | 自动取本地会话、设备和工作区，启动 Node helper，验证就绪，轮询反馈；不依赖 Server，只终止所属进程 | `apps/mac/Sources/Preview/PreviewSharingController.swift` |
| 原生反馈处理 | 查看插件连接、自动执行状态与结果；未知结果手动核实，不要求使用 Web 管理页 | `PreviewSharingView.swift`、`PreviewSharingController.swift` |
| 插件配置导入 | 一次粘贴 App 配对 JSON，仅含验收与代理凭据，不含 adminToken 或会话 ID | `extension/options.*` |
| 生命周期联动 | 会话结束、关闭、App 正常退出时停共享；Server 断开 / 变更不影响；helper 监测 App 父进程退出 | `AppModel.swift`、`PreviewSharingController.swift`、`companion/main.mjs` |
| Mac 打包资源 | 将 companion 与 extension 放进 App 资源目录，Node 运行时仍需本机安装 | `scripts/build-mac-release.sh` |
| 工作区兼容修正 | 接受 Mac 实际使用的 `workspace-...` 不透明工作区 ID，不再误按 UUID 拒绝 | `companion/main.mjs`、`tests/companion.test.mjs` |

### 当前明确不是自动化的部分

- 真实轮次完成状态自动同步，但不代表修改正确；业务方验收仍需人工操作。
- AI 工具审批与问题回复仍按 Chat 原有设置处理，不因自动派发反馈而被绕过。
- “再调一调”保存补充意见，不自动发起下一轮；需要开发者继续处理。
- 同一桥接不会并行发送反馈，但没有跨会话工作区锁，不能阻止其他人工轮次修改项目。
- 业务方共享预览凭据和反馈列表；没有独立用户身份、个人列表或完整权限模型。

## 3. 已完成的验证及其边界

2026-10-30 快捷弹窗与配置状态更新：

- 工具栏默认打开 344px 快捷弹窗，不再直接打开设置页；开关释放 / 重新建立共享连接，“配置”显式打开完整设置。
- 设置页突出当前项目、当前访问方式、项目与反馈地址以及实时状态；保存配对后收起输入，高级设置默认折叠。
- 状态区分未配置、连接中、已连接未开启、已开启、已关闭、断线、代理受限与连接异常；ZeroOmega 分流仍标记待验证。
- 同配置保留明确代理确认，配置或代理方式变更后失效；直连不需要代理确认、不修改外部代理。
- 弹窗检查已有租约，不因打开弹窗自动重连已关闭连接；过期租约不显示已连接，晚到的检查响应不恢复已关闭租约。
- `node --test apps/chrome-extension/tests/*.test.mjs`：36 项通过；`node apps/chrome-extension/scripts/check.mjs` 与 `git diff --check` 通过。
- 真实 Chrome 加载扩展的 `tests/browser.mjs` 通过，覆盖默认 popup 路径、配置按钮、开关关闭 / 再开启、设置页状态同步、直连 IP / 域名反馈及代理不受影响。
- 已检查弹窗未配置、已连接未开启、已开启及直连状态截图，并检查设置页桌面 / 窄窗口布局；证据位于 `/tmp/termrelay-popup-options/`。
- 首轮扩展浏览器流程超过原 60 秒上限，旧清理逻辑等待已退出 Chrome；修正退出清理并调整总上限至 120 秒后完整通过。

边界：弹窗页面在真实 Chrome 扩展标签页中验证，配置跳转与新标签请求由测试记录；未人工验证原生工具栏弹窗定位 / 自动收起，也未做真实双机网络或真实 AI 修改验收。
本轮只修改独立扩展与对应文档，未重跑 Mac 构建和根检查；下方跨组件检查记录属于此前项目地址配置通用化版本。

2026-10-30 项目访问配置通用化（本次最终实现）：

- App 分享面板以完整项目地址与直接 / 代理访问取代入口端口表单，默认直接访问；反馈服务 IP 与项目地址分开配置。
- 配对新增 `previewURL` / `accessMode`；helper 接受对应启动参数，元数据发布入口与访问方式；不更改 Server 或远程协议。
- 直连不设置或清除浏览器代理，也不开放预览代理；代理模式按配置主机限制，旧配对配置与 ZeroOmega 模式继续兼容。
- HTTP 页面在扩展后台生成反馈 UUID，保留提交编号幂等与失败重试；两层页面校验与项目变更保护有效。
- `node --test apps/chrome-extension/tests/*.test.mjs`：32 项通过，覆盖直连 IP / 域名、自定义代理主机、HTTP / WebSocket 转发、WSS 认证、权限拒绝和过时配对拒绝。
- `node apps/chrome-extension/scripts/check.mjs` 与真实扩展 `node apps/chrome-extension/tests/browser.mjs` 通过；浏览器覆盖合成 HTTP IP / 域名页面动态注入及实际反馈提交，原代理设置保持不变。
- `pnpm mac:test --filter PreviewSharingTests`：11 项通过，含 App 配置 → 配对 JSON → helper 接收对应页面反馈的闭环。
- 根目录 `pnpm check` 通过；Mac 全套 139 项、6 项按条件跳过、0 失败。不启动真实 Agent，不发送模型请求。
- 直连桌面 / 390px 窄窗口截图已检查，无横向溢出，证据位于 `/tmp/termrelay-configurable-preview/`；新页面打开请求在浏览器测试中记录后由 CDP 合成导航，不访问实际项目。

尚未验证：真实双机网络、业务登录与真实 AI 修改、自定义 HTTPS 主机首次权限弹窗的人工接受、Mac 原生表单视觉验收。
单次分享仍仅配置一个项目主机；不增加多项目并行、跨域资源重写或登录态迁移。项目地址不接受账号、查询参数或 hash。
以下专用 Profile 更新记录属于本日较早版本；最终版本仅在代理模式推荐专用 Profile，直连隐藏该引导。

2026-10-30 专用 Profile 引导与预览入口更新：

- `node apps/chrome-extension/scripts/check.mjs` 通过，扩展入口、JavaScript 语法和图标检查有效。
- `node --test apps/chrome-extension/tests/*.test.mjs` 共 24 项通过。
- `node apps/chrome-extension/tests/browser.mjs` 通过；覆盖默认折叠代理选择、专用 Profile 引导、明确确认后开启代理并请求打开首个入口、重复打开、新标签页打开失败恢复、代理冲突保护、ZeroOmega 模式保存和原反馈闭环。
- 浏览器使用独立临时 Profile 与合成会话；新入口的 `chrome.tabs.create` 在测试中替换为记录/失败桩，不实际访问业务站点，因此只验证入口参数和交互顺序，不代表真实业务导航已验收。
- 设置页桌面 1280px 和窄窗口 390px 截图已检查，无横向溢出；截图位于本机临时目录 `/tmp/termrelay-profile-preview/`，不提交到仓库。
- 修改文件编辑器诊断和 `git diff --check` 通过；未修改跨包执行链路，未运行根目录 `pnpm check`。

本次未实现自动创建 / 检测 Chrome Profile，不迁移 Cookie 或登录态，不放开预览域名限制。
专用 Profile 的首次建立、扩展安装和业务登录仍需人工完成；真实双机网络、日常 Profile 与验收 Profile 并行使用、真实项目访问及 AI 修改验收仍待完成。

2026-10-29 代理模式更新：`node --test apps/chrome-extension/tests/*.test.mjs` 共 24 项通过；
`node apps/chrome-extension/scripts/check.mjs` 与 `node apps/chrome-extension/tests/browser.mjs` 通过。
新增覆盖内置 / ZeroOmega 往返切换与持久化、其他扩展和管理员控制权保护、认证范围与断开不重连、
无凭据配置方案及复制失败、窄屏布局和全局代理错误归属。浏览器测试加载第二个真实代理控制扩展，
验证保留其 PAC，并通过真实 HTTPS CONNECT 挑战确认点点改提供当前租约的动态认证。
测试目标有意在 TLS 前断开；不据此宣称真实业务 HTTPS 或 ZeroOmega 产品端到端验收已完成。

以下记录为 2026-10-28 实际执行结果，不是待执行计划。

局域网闭环改造后，helper 的 8 项测试、Mac 共享的 8 项测试、Chrome 扩展浏览器检查
及根目录 `pnpm check` 均已通过。新增覆盖无 Server 启动、公网地址配置 / 变更不影响共享、
本地会话直接接收、执行意图先落盘、结果未知不重发及人工核实；不启动真实 Agent 或模型请求。
这不替代两台真实设备在业务网络中的访问及 AI 修改验收。

| 检查 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `npm run check` | 通过 | JavaScript 语法、Manifest V3 及扩展入口文件 |
| `npm test` | 16 项通过 | 独占连接、同实例复用、续约与过期、断开关闭隧道、反馈鉴权 / 幂等、进度关联及版本、保存失败重试、防重放、跨端口转发、CLI 启停 |
| `npm run test:browser` | 通过 | 实际粘贴配对、错误恢复、代理明确授权、高级暂停、桌面 / 390px 窄屏布局、点点改命名、运行 / 审批 / 完成、验收、显式断开不抢回、跨端口资源与选取隐私 |
| `pnpm mac:test --filter PreviewSharingTests` | 9 项通过 | 本地自动排队、真实轮次关联与乱序通知、其他轮次隔离、审批策略不变、等待问答、完成 / 中断和错误结果、helper 生命周期 |
| 仓库根目录 `pnpm check` | 通过 | 协议、TypeScript、Linux 检查及 Mac 测试（真实 Provider 探针按条件跳过）；不自动包含扩展独立检查 |
| `pnpm test:release` | 12 项通过 | 现有发布脚本回归；Mac 打包脚本另通过 `bash -n`，未实际生成 Mac Release 包 |

验证边界：

- 测试使用合成页面、合成本地会话，不会启动真实 Agent 或发送模型请求，不需要 Relay。
- 浏览器测试通过 CDP 提供测试页面，没有访问实际业务域名、企业 SSO 或真实项目。
- CONNECT 测试验证认证、限制及字节转发，没有替代真实业务 HTTPS / WSS / HMR 验收。
- 未在另一台业务方电脑上验证公司网络、防火墙及实际 Chrome 管理策略。
- App 控制器测试直接调用合成本地运行时，没有替代真实业务 SSO、真实模型修改及人工原生 UI 验收。

## 4. 下一步：按顺序完成真实试用验收

这些是当前交付缺口，不能因为自动化检查通过就标为已完成。

| 编号 | 状态 | 工作 | 完成标准 |
| --- | --- | --- | --- |
| V-01 | 待完成 | 启动 Mac App 和测试项目 ACP 会话，不要求 Server 在线 | 桥接启动并正确显示设备、工作区及会话；无效绑定被拒绝 |
| V-02 | 待完成 | 在另一台电脑配对插件并访问开发者代理 | 反馈连接成功；无需修改业务方 hosts；未授权访问失败 |
| V-03 | 待完成 | 验证原域名的真实项目登录与操作 | 使用业务方自己的账号正常登录，接口和资源可用，无证书错误 |
| V-04 | 待完成 | 验证多端口及项目实际 WSS / HMR | 页面与静态资源跨端口可访问且无需列举端口；热更新可用；其他域名和非法端口被拒绝 |
| V-05 | 待完成 | 在真实业务页面验证元素选取 | 选取不会触发查询、提交或跳转；弹窗、图标、表格等不能安全选取时有明确处理方式 |
| V-06 | 待完成 | 发起一次受控的真实代码修改 | 业务方提交一条小改动，自动进入绑定会话；AI 工具审批保持原策略；插件展示真实轮次开始 / 完成，修改可在页面看到 |
| V-07 | 待完成 | 完成人工验收与补充意见 | 修改摘要可见，业务方可以通过或提出继续修改；不会误触发重复执行 |
| V-08 | 待完成 | 真实断线与失败场景验收 | 会话忙碌、退出、桥接重启及响应丢失不串会话、不自动重发，未知结果可人工核实 |

首次真实 AI 验收必须由开发者明确触发，选择测试项目和可回退的小改动。
记录验证环境、复现步骤和结果摘要，不将 Token、Cookie、公司业务数据或真实路径写入进展文档。

## 5. 后续开发待办

以下是建议优先级，不代表所有项目都已确定纳入下一版本。

| 编号 | 优先级 | 待办 | 当前缺口 / 完成标准 |
| --- | --- | --- | --- |
| D-01 | 优先 | 代理与反馈控制链路的传输保护 | 当前 HTTP + Basic 仅限受信 LAN；扩大使用前明确加密、接入与威胁边界，不改变项目原 HTTPS |
| D-02 | 部分完成 | 配对、凭据撤销与轮换 | 已在 App 一键复制仅供验收者的配对 JSON；仍缺原生撤销 / 轮换，停服再开启会恢复原凭据 |
| D-03 | 部分完成 | 会话选择、绑定与失效处理 UI | 已在当前会话一键绑定和启停，不再填写 UUID；后续仍需历史反馈查看、异常锁恢复与显式迁移设计 |
| D-04 | 部分完成 | 可靠的轮次关联和完成跟踪 | 已关联真实 turn，自动同步运行 / 审批 / 问答 / 完成 / 失败并隔离其他轮次；真实业务项目端到端验收待完成 |
| D-05 | 优先 | DOM 选取兼容与失效提示 | 验证页面早期事件、滚动、SPA 路由及 HMR；增强目标失效处理，不依赖固定旧坐标 |
| D-06 | 后续 | 查询与 hash 路由的精细过滤 | 当前全部丢弃；在不带出凭据的前提下保留必要路由和复现条件 |
| D-07 | 后续 | 执行仲裁与工作区并发约束 | 现有 Mac 会拒绝忙碌会话，但无跨会话互斥；明确人工输入、反馈队列和同目录修改策略 |
| D-08 | 后续 | 继续修改的受控轮次 | 补充意见经再次确认后发送，固定本轮输入版本，保持反馈到多轮执行的关联 |
| D-09 | 后续 | 身份与反馈可见范围 | 当前共享 Token；是否需要独立账号、个人反馈、协作权限需先确认 |
| D-10 | 后续 | 草稿恢复与反馈体验 | 当前草稿只在页面内存，列表按 origin 过滤；补充跨刷新恢复、路由筛选与可靠元素重定位 |
| D-11 | 后续 | 数据管理 | 当前本机 JSON、最多 1000 条；明确保留期限、归档、导出、清理及异常文件恢复 |
| D-12 | 部分完成 | 企业代理兼容 | 已提供内置 / ZeroOmega 切换和无凭据快速配置方案，合成扩展验证规则保留与动态认证；真实 ZeroOmega 版本及企业网络验收待完成，不绕过管理员策略 |
| D-13 | 已确认 | 局域网反馈与 App 集成 | App 已管理代理、配对和反馈，并直接调用本地会话；Server 反馈模块与存储不属于本功能范围 |
| D-14 | 待决策 | 专用反馈会话 | 当前绑定已有会话；如引入专用会话，须先解决上下文、生命周期、审批及共享工作区冲突 |

## 6. 本期明确不做

- 截图、录屏、图片标注及 AI 看图。
- 自研浏览器、完整浏览器自动化、手机 Chrome 扩展。
- 多项目同时共享、同一 Profile 同域名按标签页分流；单项目地址已支持按分享配置不同域名或局域网 IP。
- 无人确认自动改代码、自动提交 Git、自动发布。
- 绕过企业网络隔离，或向公网提供未保护的本地代理 / Relay。

## 7. 后续维护方式

每次开发后同步更新本文件：已实现内容、实际验证、剩余限制分别记录。
完成 V / D 编号对应事项时更新状态与结果；需求发生变化时同步需求草案。
“代码已实现”“自动化已验证”“真实环境已验收”必须分开描述，
不将手动确认能力写成自动化能力，也不将已知限制默认为后续已解决。
