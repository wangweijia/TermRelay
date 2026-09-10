# TermRelay

Your terminals, within reach.

TermRelay 是一个把真实 Mac 上的 AI CLI 会话安全地中继到 Web 管理端的实验性平台。macOS、Server 与 Web 已接入真实 WebSocket Client 和双向终端命令链路。

## 仓库布局

```text
apps/
  mac/                     SwiftUI macOS 应用与会话核心
  server/                  NestJS API / WebSocket / 静态资源宿主
  web/                     Vue 3 管理页面
packages/contracts/        JSON Schema（协议唯一事实源）及生成类型
deploy/server/             单容器构建和本地依赖编排
docs/                      架构、可行性与开发决策
scripts/                   仓库级校验脚本
```

完整边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，Codex 结构化接入决策见 [docs/ADR-001-CODEX-APP-SERVER.md](docs/ADR-001-CODEX-APP-SERVER.md)，通用智能体适配层和新 Provider 接入流程见 [docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md](docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md)，可行性结论见 [docs/FEASIBILITY.md](docs/FEASIBILITY.md)，开发/生产数据库见 [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md)。原始实现说明保留在 [TermRelay_开发实现文档.md](TermRelay_开发实现文档.md)。

## 开始开发

环境要求：Node.js 22、pnpm 10+、Swift 6 / Xcode 16+；运行完整 Server 还需要 MySQL 8。

```bash
pnpm install
pnpm check
pnpm dev:server
pnpm dev:web
```

Mac App 可以在没有 Server 的情况下作为本地终端运行：

```bash
cd apps/mac
swift test
swift run TermRelay
```

在界面中选择工作目录和“登录 Shell”或“Codex”，即可在真实 PTY 中启动交互式会话。“显示探针”按钮可验证 ANSI、TrueColor、中文、Emoji 和 PTY resize。`swift run` 只用于开发期启动；正式 Xcode 工程、签名与公证属于后续工作。

## 当前状态

- 已建立 Server、Web、Mac 和 Contracts 的工程边界。
- 已定义协议 envelope、注册、心跳、终端输出、命令 ACK 和错误 Schema。
- 已提供 Server 健康检查、两类 WebSocket 网关和 Web 页面骨架。
- Server S1 已通过真实 WebSocket 探测：运行时协议校验、设备注册、唯一连接映射、心跳和超时离线均可用。
- Server S2 已实现设备状态按序持久化，以及 `GET /api/devices` 和 `GET /api/devices/:id`；真实 MySQL 端到端探测已通过。
- Server S3 已实现工作区/会话注册、terminal/structured runtime 边界、终端输出连续 seq 校验与幂等落库，以及 Session/Event 只读 API。
- Server S4 已实现 Browser Session 订阅、无丢包历史接续与实时广播。
- S5 已接入真实 Mac `URLSessionWebSocketTask` Client、自动重连、注册/心跳、工作区/Session 同步、终端输出上传和 16 MiB 离线输出缓冲。
- Web xterm.js 已支持远程输入、resize、Ctrl-C 和停止；Server 校验 Session 归属后转发，Mac 返回带幂等 `commandId` 的 ACK。
- 事件级确认与完整断线补传、命令持久化、Cloudflare Access、应用签名和生产分发尚未完成。
