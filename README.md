# TermRelay

Your terminals, within reach.

TermRelay 是一个把真实 Mac 上的 AI CLI 会话安全地中继到 Web 管理端的实验性平台。仓库目前处于 **M0：可编译骨架与协议基线**。

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

完整边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，可行性结论见 [docs/FEASIBILITY.md](docs/FEASIBILITY.md)。原始实现说明保留在 [TermRelay_开发实现文档.md](TermRelay_开发实现文档.md)。

## 开始开发

环境要求：Node.js 22、pnpm 10+、Swift 6 / Xcode 16+；运行完整 Server 还需要 MySQL 8。

```bash
pnpm install
pnpm check
pnpm dev:server
pnpm dev:web
```

Mac 骨架可以独立验证：

```bash
cd apps/mac
swift test
swift run TermRelay
```

`swift run` 只用于开发期启动；生成签名的 `.app`、SwiftTerm 与 PTY 接入属于阶段 0 后续工作。

## 当前状态

- 已建立 Server、Web、Mac 和 Contracts 的工程边界。
- 已定义协议 envelope、注册、心跳、终端输出、命令 ACK 和错误 Schema。
- 已提供 Server 健康检查、两类 WebSocket 网关和 Web 页面骨架。
- 已提供 SwiftUI App、连接状态与基础会话模型。
- 尚未完成真实 PTY、SwiftTerm、MySQL migration、Cloudflare Access 身份验证和生产签名。
