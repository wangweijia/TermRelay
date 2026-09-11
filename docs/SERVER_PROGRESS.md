# TermRelay Server 端任务进展

> 更新日期：2026-09-11
>
> 当前阶段：S5——真实 Mac 网络客户端与双向终端命令已实现
>
> 下一阶段：事件确认、完整断线补传与 Session 生命周期

## 总体结论

真实 Mac App 已接入 Server WebSocket，能够注册设备/工作区/Session、发送心跳与终端输出；Web 可以把输入、resize、Ctrl-C 和停止命令定向转发到目标 Mac PTY，并接收执行 ACK。

- 工程基础完成度：约 78%。
- Server MVP 功能完成度：约 70%。
- 阶段 2“Server 与 Mac 闭环”完成度：约 82%。
- 技术可行性：可行，当前未发现需要改变总体架构的阻塞项。
- 当前核心缺口：事件级确认与完整断线补传、Session 结束状态、命令持久化和实机人工验收。

以上比例是基于关键路径权重的工程估算，不是正式验收数据。

## 已完成能力

### 工程与运行环境

- NestJS 11、Fastify、原生 `ws` Adapter。
- Vue 静态构建产物由 Server 单容器托管。
- TypeScript 构建、类型检查与自动化测试。
- MySQL 8 migration，`synchronize: false`。
- 本地开发库与 Jetson 最终部署库隔离。
- 本地 Docker Compose 开发栈已启动并通过健康检查。
- 本地与 Jetson 数据库迁移和数据库健康检查均已实测。
- 已提供 `pnpm release:server` 离线发布流程：构建 Jetson ARM64 镜像并打包镜像、Compose、生产环境模板和一键部署/健康检查脚本。

环境与运行命令见 `docs/ENVIRONMENTS.md`。

### HTTP

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /health` | 完成 | 数据库启用时执行 `SELECT 1`，异常返回 503 |
| `GET /api/devices` | 完成 | 返回持久化设备并覆盖当前进程中的实时状态 |
| `GET /api/devices/:id` | 完成 | 返回设备详情，不存在时返回 404 |
| `GET /api/sessions` | 完成 | 返回持久化会话列表 |
| `GET /api/sessions/:id` | 完成 | 返回会话详情与当前 `stateVersion` |
| `GET /api/sessions/:id/events` | 完成 | 按 seq 升序分页返回事件，支持 `afterSeq` 和 `limit` |

### Client WebSocket（S1）

`/ws/client` 已实现：

- AJV Draft 2020-12 Envelope 与 payload 运行时校验。
- `device.register` 注册及 `device.registered` 确认。
- 每个 `device_id` 唯一连接，新连接替换旧连接。
- `device.heartbeat` 状态和活动会话数更新。
- 未注册超时、心跳超时、主动断开与离线状态。
- 非法 payload、未注册心跳和协议版本拒绝。

真实网络探测已通过：

```bash
pnpm --filter @termrelay/server probe:s1
```

```text
✓ registration acknowledgement and heartbeat
✓ unregistered heartbeat rejected
✓ unsupported protocol version rejected
Server S1 WebSocket probe passed.
```

### 设备持久化与查询（S2）

已实现：

- `DeviceEntity` 与现有 `devices` migration 对齐。
- `DeviceRepository` 持久化注册、心跳和离线快照。
- Server 启动时把遗留的在线、中间态设备标记为离线。
- `DevicesService` 合并 MySQL 记录与当前内存实时状态。
- 同一设备写操作按事件顺序串行执行，避免注册、心跳、断开并发造成重复主键或旧状态覆盖新状态。
- HTTP 查询会等待当前待完成的持久化操作。
- MySQL 使用毫秒精度的 `ON UPDATE CURRENT_TIMESTAMP(3)`，避免同一秒内更新时间早于创建时间。
- 数据库关闭时，Device API 仍可返回当前进程内的瞬时设备状态。

真实数据库端到端探测已通过：

```bash
pnpm --filter @termrelay/server probe:s2
```

```text
✓ device register, heartbeat, and disconnect persisted in order
✓ device detail and list APIs returned persisted state
Server S2 device persistence probe passed.
```

### 会话与终端事件（S3）

已实现：

- 新增 `workspace.registered` 和 `session.started` 跨端 Schema 与 Swift/TypeScript 引导类型。
- `session.started` 明确使用 `runtimeMode=terminal|structured`，Session 核心不依赖 Codex。
- `WorkspaceEntity`、`SessionEntity`、`SessionEventEntity` 及 Repository/Service。
- 工作区注册与设备归属校验；不可用或不属于当前设备的工作区不能创建会话。
- `session.started` 以 seq 0 建立会话和初始事件。
- `terminal.output` 进行 payload、session/device 归属和连续 seq 校验。
- 相同 `session_id + seq + payload` 重传会被幂等忽略；相同 seq 的不同内容和跳号会返回 `conflict`。
- 同一设备事件串行落库，工作区、会话和输出可以连续发送而不会发生外键竞态。
- 单条 terminal output 的 Base64 字段限制约 1 MiB，并拒绝非法 Base64。
- Terminal Output 默认查询保留期为 24 小时，可通过 `TERMINAL_EVENT_TTL_HOURS` 调整；物理清理任务仍待实现。
- 事件 API 支持从指定 seq 继续读取，给下一阶段历史加载与实时接续提供边界。

真实数据库端到端探测已通过：

```bash
pnpm --filter @termrelay/server probe:s3
```

```text
✓ workspace and terminal session persisted
✓ duplicate output ignored and sequence gap rejected
✓ session detail and ordered event APIs returned complete output
Server S3 session and terminal event probe passed.
```

### 浏览器订阅与只读终端（S4）

已实现：

- `/ws/web` 的 `session.subscribe`、`session.unsubscribe` 运行时 Schema 校验。
- 会话与设备归属校验、每浏览器默认最多 16 个 Session 订阅。
- HTTP 历史加载后按最后 seq 接续 WebSocket；Server 最多回放 10,000 个缺口事件。
- 订阅初始化期间缓冲实时事件，先发送历史快照再按 seq 刷新缓冲。
- 只广播成功提交到 MySQL 的事件；重复上传不会重复推送。
- Browser Gateway 对每个订阅维护 last seq，并抑制重复或旧事件。
- Vue/Pinia 会话列表、连接状态、错误状态、历史分页和指数退避重连。
- xterm.js 只读终端，支持 ANSI、UTF-8、滚动历史和容器自适应 resize。
- 页面切换会取消旧订阅；WebSocket 重连会从本地最后 seq 恢复。
- 移除未使用的 Element Plus 全量运行时导入，降低页面主包体积。

真实 Client → Server → Browser 双 WebSocket 探测已通过：

```bash
pnpm --filter @termrelay/server probe:s4
```

```text
✓ browser subscription received an ordered history snapshot
✓ terminal output streamed live without duplicate delivery
✓ unsubscribe stopped subsequent terminal events
Server S4 read-only terminal relay probe passed.
```

### 真实 Mac Client 与双向命令（S5）

已实现：

- Mac 使用系统 `URLSessionWebSocketTask` 自动连接和指数退避重连。
- 注册设备并按 Server 下发间隔发送心跳，连接恢复后重新同步工作区与 Session。
- 本地 PTY 输出沿用 40 ms / 8 KiB 批处理，通过 `terminal.output` 上传。
- 未建立连接或 Session 尚未声明时，输出进入最大 16 MiB 的有界内存缓存，声明成功后按 seq 发送。
- Web xterm.js 接收键盘/粘贴输入并发送 Base64 `terminal.input`，尺寸变化发送 `terminal.resize`。
- Web 提供 Ctrl-C 与停止按钮，对应 `session.interrupt`、`session.stop`。
- 四类命令均要求 UUID `commandId`；Server 校验 Session 归属、运行状态和目标 Mac 在线状态。
- Mac 对已执行命令维护最近 512 个幂等 ID，并返回 `command.ack`；Server 默认 15 秒超时。
- 新增 `probe:s5` 双 WebSocket 探针，覆盖四类命令定向路由与 ACK 回程。

当前环境已完成协议、Gateway 和命令路由组件测试。`probe:s5` 尚未对重新部署后的开发端口 3007 执行真实网络复验；真实 Mac GUI 启动、选择目录并与浏览器交互仍需一次人工实机验收。

## 数据库结构

初始 migration 定义 8 张业务表：

| 表 | 当前业务接入状态 |
| --- | --- |
| `devices` | 已接入 Entity、Repository、Service 与 HTTP API |
| `cli_tools` | 尚未接入 |
| `workspaces` | 已接入注册、设备归属和可用状态校验 |
| `sessions` | 已接入 terminal/structured runtime、状态与版本持久化 |
| `commands` | 已实现内存路由、ACK 与超时；数据库持久化尚未接入 |
| `events` | 已接入 `session.started` 和 `terminal.output` 有序持久化 |
| `approvals` | 尚未接入 |
| `audit_logs` | 尚未接入 |

生产运行账户保持最小业务权限，migration 管理权限与应用运行权限分离。凭据只通过环境变量注入，不进入仓库。

## 协议状态

当前 16 个 JSON Schema 均已通过检查；S5 新增 Terminal Input/Resize、Session Interrupt/Stop。

运行时校验已经接入 Server。仍有一项协议技术债：TypeScript/Swift 的 `generated` 类型目前是手写引导版本，尚未建立从 JSON Schema 自动生成并在 CI 检查无漂移的正式流程。

## 自动化与实测

当前 Server 自动化测试共 39 项，Mac 自动化测试共 4 项，覆盖：

- AppModule 无数据库模式依赖注入与生命周期。
- 协议 Envelope/payload 校验。
- 注册、心跳、断开、重复设备连接替换。
- 注册超时与心跳超时。
- Gateway 正常与异常路径。
- Device Service 的内存模式、实时覆盖和同设备串行落库。
- Device Controller 列表、详情与 404。
- Workspace、Session 与 Terminal Output 协议上下文和 Base64 校验。
- 同设备工作区/会话事件串行处理、授权失败和 seq 冲突。
- Session Controller 列表、详情、事件分页、404 与非法参数。
- Browser 协议校验、Session 归属验证、历史快照、初始化缓冲、实时推送、去重和取消订阅。
- 双向命令 Schema、Session/Device 路由、离线拒绝、Mac ACK 归属与幂等命令解码。

已实测：

- Contracts 检查、Server 构建、类型检查、自动化测试。
- 无数据库和本地开发数据库两种启动模式。
- `/health`、Web 静态资源、两个 WebSocket 入口。
- MySQL migration 正向执行、本地 Compose 开发栈。
- S1 真实 WebSocket 网络探测。
- S2 WebSocket → MySQL → HTTP API 端到端探测。
- S3 工作区 → 会话 → 连续输出 → 去重/跳号拒绝 → HTTP 有序读回探测。
- S4 Client → Server → Browser 历史快照、实时输出、去重与取消订阅探测。
- 本地和 Jetson 生产库的第二个 migration；生产应用账户已只读验证新列与 migration 记录。

尚未验证：

- migration 回滚与升级失败恢复。
- 当前代码的生产镜像重新构建和 Jetson 应用部署。
- WebSocket 大量输出、慢浏览器背压、多设备和多会话并发。
- 真实 Mac GUI 与 Server/Web 的人工交互验收及长时间断线重连。
- `probe:s5` 在更新后的开发端口 3007 上进行真实网络复验。
- Cloudflare Access、客户端身份认证和速率限制。

## 当前安全边界

当前实现只适合本机或受控局域网开发，不能直接暴露到公网：

- `/ws/client` 尚无设备 credential、签名、来源限制和速率限制。
- `/ws/web` 尚未验证 Cloudflare Access 身份。
- 生产 Compose 默认通过 `0.0.0.0:3006` 提供局域网直连入口，局域网内任何设备都可以访问 Web、HTTP API 和 WebSocket；当前没有应用层认证。

在真实设备联调前，应确定 LAN 入口和设备认证方案；在公网发布前必须完成 Cloudflare Access 与安全限制。

## 下一步优先级

1. 为 terminal output 增加 Server ACK 和 Mac 已确认 seq Journal，实现无歧义断线补传。
2. 持久化 command 状态，并补测超时、背压、多设备与多会话。
3. 增加 session state changed、finished 和 failed 事件及 Web 状态更新。
4. 在真实 Mac GUI 上完成启动 Shell/Codex、浏览器输入/resize/Ctrl-C/停止的人工验收。
5. 实现 Terminal Event 物理过期清理和每会话配额。
6. 建立 JSON Schema 到 TypeScript/Swift 的正式代码生成。
7. PTY 闭环稳定后进入 `SA-0：AgentCore + FakeAgentAdapter`。
8. 接入 Cloudflare Access、设备身份和生产网络限制。

完成第 1～4 项后，终端中继链路才具备可恢复、可追踪的正式 MVP 质量。

## 下次开发交接

开始前运行：

```bash
pnpm contracts:check
pnpm --filter @termrelay/server test
```

验证 S1～S5 时，先按 `docs/ENVIRONMENTS.md` 启动本地数据库和当前 Server，然后执行：

```bash
pnpm --filter @termrelay/server probe:s1
pnpm --filter @termrelay/server probe:s2
pnpm --filter @termrelay/server probe:s3
pnpm --filter @termrelay/server probe:s4
pnpm --filter @termrelay/server probe:s5
```

明确未完成：

- terminal output 的 Server ACK、已确认 seq Journal 与完整断线补传。
- command 数据库持久化、Session 结束/失败状态同步。
- 真实 Mac GUI 与浏览器的人工实机验收。
- 正式 Schema 代码生成。
- Cloudflare Access、设备认证、限流和生产网络加固。

后续每个阶段应同步更新本文件中的阶段、实测结果、安全边界和下一优先级。
