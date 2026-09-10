# TermRelay

Your terminals, within reach.

TermRelay 是一个把真实 Mac 上的 AI CLI 会话安全地中继到 Web 管理端的实验性平台。macOS 端已完成 **阶段 0：本地终端与协议探针实现**，Server 闭环仍处于工程骨架阶段。

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

完整边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，可行性结论见 [docs/FEASIBILITY.md](docs/FEASIBILITY.md)，开发/生产数据库见 [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md)。原始实现说明保留在 [TermRelay_开发实现文档.md](TermRelay_开发实现文档.md)。

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
- Mac App 已接入 SwiftTerm、本地 PTY、登录 Shell/Codex 启动、目录选择、Ctrl-C、停止和有界输出批处理探针。
- Server 仍未与 Mac 建立 WebSocket 闭环；Cloudflare Access、应用签名和生产分发尚未完成。
