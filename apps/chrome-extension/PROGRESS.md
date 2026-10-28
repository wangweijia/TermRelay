# Chrome 预览与反馈：进展与待办

> 更新日期：2026-10-28。
> 当前阶段：已从独立 CLI 实验版接入 Mac App 原生 UI，完成合成环境验证，尚未完成真实业务项目端到端验收。
> 使用方法见 [README](README.md)，产品交互与未决策项见 [需求草案](../../docs/CHROME_PREVIEW_FEEDBACK_REQUIREMENTS.md)。

## 1. 当前实现路线

扩展和桥接代码放在 `apps/chrome-extension`，暂未加入根 pnpm workspace；
Mac 原生入口、托管进程与反馈管理已接入 `apps/mac`。
没有修改 TermRelay Server、数据库或协议生成文件。

```text
预览访问：
Chrome 插件 -> 本机受限 CONNECT 代理 -> 127.0.0.1:项目原端口

App 控制：
项目会话 -> 共享预览与反馈 -> 开启共享 / 复制配对 / 查看反馈 / 停止共享

反馈执行：
Chrome 插件 -> App 托管的本机反馈桥接 -> 开发者在 App 确认
    -> TermRelay Server /ws/web -> 已有普通 ACP 会话
    -> 开发者核实修改结果 -> 业务方验收
```

本机桥接是现有 Server 浏览器协议的客户端，不直接操作 CLI，
不调用通用外部 AI API，也不自动创建专用会话。
“优先绑定已有会话”已用于本实验版，不代表专用会话等后续产品选项已经定案。
用户不再需要运行 CLI、查 UUID、阅读 Token 文件或打开独立管理页；
旧命令行入口和 Web 管理页只保留作开发诊断。

## 2. 已完成

| 能力 | 已实现范围 | 主要文件 |
| --- | --- | --- |
| 独立项目 | Node.js 22+，无需额外安装依赖，独立启动与检查命令 | `package.json`、`scripts/check.mjs` |
| Chrome 扩展 | Manifest V3、配对设置页、连接测试、扩展图标入口 | `extension/manifest.json`、`options.*`、`background.js` |
| 域名代理 | 仅代理 `page-gateway-local.nioint.com`，保留原 URL、端口及 TLS | `extension/background.js`、`companion/proxy.mjs` |
| 多端口授权 | 一个代理入口转发多个显式授权的项目端口，目标固定为本机 loopback | `companion/main.mjs`、`proxy.mjs` |
| 代理访问限制 | Basic 凭据、目标域名与端口允许列表；不提供任意目标转发 | `companion/proxy.mjs` |
| 页面反馈 UI | 右下角按钮、右侧浮层、鼠标高亮、点击选取、选择外层、Esc 退出、整页反馈 | `extension/content.js` |
| 文字与上下文 | 修改描述、可选复现步骤、有限元素文字及结构线索，提交前查看上下文 | `extension/content.js`、`companion/model.mjs` |
| 基础敏感信息过滤 | 不采集截图、原始 outerHTML、表单值、Cookie、存储；过滤 URL 查询与 hash | `extension/content.js`、`companion/model.mjs` |
| 受限反馈接口 | 提交、列表、验收；反馈 Token 与管理 Token 分离，网页脚本来源被拒绝 | `companion/server.mjs` |
| 本机管理页 | 仅 loopback 监听，查看反馈、核对绑定、人工确认发送、填写结果摘要 | `companion/owner.*` |
| 已有会话绑定 | 固定 Relay、设备、工作区和会话；拒绝 PTY、外部 AI 对话、已结束会话 | `companion/main.mjs`、`relay.mjs` |
| 轮次发送 | 通过 `/ws/web` 发送协议 v2 `tool.turn.start`，关联命令 ACK | `companion/relay.mjs` |
| 提交与执行去重 | 反馈 UUID 幂等；执行意图先落盘；已经尝试发送的记录不自动重发 | `companion/server.mjs`、`store.mjs` |
| 未知结果保护 | 断线、超时或发送中重启标记未知；核实前阻止本桥接继续发送其他反馈 | `companion/relay.mjs`、`store.mjs`、`server.mjs` |
| 人工验收闭环 | 开发者核实后标记待验收，业务方选择通过或填写继续修改意见 | `companion/owner.js`、`extension/content.js` |
| 本地持久化 | 私有凭据文件、JSON 反馈记录、单数据目录进程锁、正常停止清理锁 | `companion/main.mjs`、`store.mjs` |
| Mac 会话入口 | 会话顶部打开“共享预览与反馈”，固定绑定此会话，不跟随主窗口切换 | `apps/mac/Sources/AppShell/ContentView.swift`、`PreviewSharingView.swift` |
| 原生共享面板 | “共享与配对 / 页面反馈”页签，端口与本机 IP 配置、启停、显示插件目录、复制配对 JSON | `apps/mac/Sources/AppShell/PreviewSharingView.swift` |
| App 托管服务 | 自动取 Server、设备和工作区，启动 Node helper，验证就绪，轮询反馈；只终止所属进程 | `apps/mac/Sources/Preview/PreviewSharingController.swift` |
| 原生反馈处理 | 查看记录、人工确认发送、核实完成后填写摘要或标记失败，不要求使用 Web 管理页 | `PreviewSharingView.swift`、`PreviewSharingController.swift` |
| 插件配置导入 | 一次粘贴 App 配对 JSON，仅含验收与代理凭据，不含 adminToken 或会话 ID | `extension/options.*` |
| 生命周期联动 | 会话结束、关闭、断连、改 Server、App 正常退出时停共享；helper 监测 App 父进程退出 | `AppModel.swift`、`PreviewSharingController.swift`、`companion/main.mjs` |
| Mac 打包资源 | 将 companion 与 extension 放进 App 资源目录，Node 运行时仍需本机安装 | `scripts/build-mac-release.sh` |
| 工作区兼容修正 | 接受 Mac 实际使用的 `workspace-...` 不透明工作区 ID，不再误按 UUID 拒绝 | `companion/relay.mjs`、`tests/companion.test.mjs` |

### 当前明确不是自动化的部分

- “已送达会话”只代表命令 ACK，不代表 AI 已完成，更不代表修改正确。
- AI 审批与执行结果由开发者在 TermRelay 中查看；完成后手动填写摘要交付验收。
- “仍需修改”保存补充意见，不自动发起下一轮；需要开发者继续处理。
- 同一桥接不会并行发送反馈，但没有跨会话工作区锁，不能阻止其他人工轮次修改项目。
- 业务方共享预览凭据和反馈列表；没有独立用户身份、个人列表或完整权限模型。

## 3. 已完成的验证及其边界

以下记录为 2026-10-28 实际执行结果，不是待执行计划。

| 检查 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `npm run check` | 通过 | JavaScript 语法、Manifest V3 及扩展入口文件 |
| `npm test` | 10 项通过 | 反馈校验、鉴权、幂等、人工确认、未知结果、重启恢复、真实 WebSocket 握手及协议发送、CONNECT 转发、CLI 启停 |
| `npm run test:browser` | 通过 | 独立临时 Chrome Profile 加载实际扩展，设置与连接、代理启停、元素选取、业务点击隔离、真实插件到桥接的反馈提交、URL 过滤、整页反馈 |
| `pnpm mac:test --filter PreviewSharingTests` | 7 项通过 | 原生配置、资源定位、错误提示、PTY 拒绝、实际 App 控制器启动与停止 helper、绑定及配对权限 |
| 仓库根目录 `pnpm check` | 通过 | 协议、TypeScript、Linux 检查及 Mac 135 项测试（6 项按条件跳过）；不自动包含扩展独立检查 |
| `pnpm test:release` | 12 项通过 | 现有发布脚本回归；Mac 打包脚本另通过 `bash -n`，未实际生成 Mac Release 包 |

验证边界：

- 测试使用合成页面、合成会话及模拟 Relay，不会启动真实 Agent 或发送模型请求。
- 浏览器测试通过 CDP 提供测试页面，没有访问实际业务域名、企业 SSO 或真实项目。
- CONNECT 测试验证认证、限制及字节转发，没有替代真实业务 HTTPS / WSS / HMR 验收。
- 开发时 `127.0.0.1:3007` 没有运行中的 Relay，尚未连接真实 Mac 项目会话修改代码。
- 未在另一台业务方电脑上验证公司网络、防火墙及实际 Chrome 管理策略。
- App 控制器测试使用合成 Relay，没有替代真实业务 SSO、真实模型修改及人工原生 UI 验收。

## 4. 下一步：按顺序完成真实试用验收

这些是当前交付缺口，不能因为自动化检查通过就标为已完成。

| 编号 | 状态 | 工作 | 完成标准 |
| --- | --- | --- | --- |
| V-01 | 待完成 | 启动实际 Relay、Mac App 和测试项目 ACP 会话 | 桥接启动并正确显示设备、工作区及会话；无效绑定被拒绝 |
| V-02 | 待完成 | 在另一台电脑配对插件并访问开发者代理 | 反馈连接成功；无需修改业务方 hosts；未授权访问失败 |
| V-03 | 待完成 | 验证原域名的真实项目登录与操作 | 使用业务方自己的账号正常登录，接口和资源可用，无证书错误 |
| V-04 | 待完成 | 验证多端口及项目实际 WSS / HMR | 至少两个授权端口可访问；热更新可用；未授权端口被拒绝 |
| V-05 | 待完成 | 在真实业务页面验证元素选取 | 选取不会触发查询、提交或跳转；弹窗、图标、表格等不能安全选取时有明确处理方式 |
| V-06 | 待完成 | 发起一次受控的真实代码修改 | 业务方提交一条小改动，开发者确认后进入正确会话；审批正常；修改可在页面看到 |
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
| D-04 | 优先 | 可靠的轮次关联和完成跟踪 | 当前仅跟踪命令 ACK；需关联真实 turn，区分执行中、审批、完成、失败和未知，避免误认人工轮次 |
| D-05 | 优先 | DOM 选取兼容与失效提示 | 验证页面早期事件、滚动、SPA 路由及 HMR；增强目标失效处理，不依赖固定旧坐标 |
| D-06 | 后续 | 查询与 hash 路由的精细过滤 | 当前全部丢弃；在不带出凭据的前提下保留必要路由和复现条件 |
| D-07 | 后续 | 执行仲裁与工作区并发约束 | 现有 Mac 会拒绝忙碌会话，但无跨会话互斥；明确人工输入、反馈队列和同目录修改策略 |
| D-08 | 后续 | 继续修改的受控轮次 | 补充意见经再次确认后发送，固定本轮输入版本，保持反馈到多轮执行的关联 |
| D-09 | 后续 | 身份与反馈可见范围 | 当前共享 Token；是否需要独立账号、个人反馈、协作权限需先确认 |
| D-10 | 后续 | 草稿恢复与反馈体验 | 当前草稿只在页面内存，列表按 origin 过滤；补充跨刷新恢复、路由筛选与可靠元素重定位 |
| D-11 | 后续 | 数据管理 | 当前本机 JSON、最多 1000 条；明确保留期限、归档、导出、清理及异常文件恢复 |
| D-12 | 后续 | 企业代理兼容 | 当前非目标域名 DIRECT，仅适用于独立 Profile；若扩大使用，设计既有代理的保留与冲突处理 |
| D-13 | 部分完成 | 正式 Server 反馈模块与 App 集成 | App 已管理代理、配对及反馈；是否迁移本机反馈存储到 Server 仍待决定 |
| D-14 | 待决策 | 专用反馈会话 | 当前绑定已有会话；如引入专用会话，须先解决上下文、生命周期、审批及共享工作区冲突 |

## 6. 本期明确不做

- 截图、录屏、图片标注及 AI 看图。
- 自研浏览器、完整浏览器自动化、手机 Chrome 扩展。
- 每人不同域名、同一 Profile 同域名按标签页分流。
- 无人确认自动改代码、自动提交 Git、自动发布。
- 绕过企业网络隔离，或向公网提供未保护的本地代理 / Relay。

## 7. 后续维护方式

每次开发后同步更新本文件：已实现内容、实际验证、剩余限制分别记录。
完成 V / D 编号对应事项时更新状态与结果；需求发生变化时同步需求草案。
“代码已实现”“自动化已验证”“真实环境已验收”必须分开描述，
不将手动确认能力写成自动化能力，也不将已知限制默认为后续已解决。
