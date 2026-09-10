# TermRelay 工程结构与边界

## 目录结构

```text
termrelay/
├── apps/
│   ├── mac/
│   │   ├── Package.swift            # M0 可编译入口；阶段 0 后生成 Xcode 工程
│   │   ├── Sources/
│   │   │   ├── AppShell/            # SwiftUI 生命周期、窗口、设置
│   │   │   ├── Terminal/            # 渲染抽象和后续 SwiftTerm/PTY 实现
│   │   │   ├── Session/             # 会话状态机与进程编排
│   │   │   ├── Remote/              # WebSocket、重连、消息路由
│   │   │   └── Tools/               # CLI 工具适配器
│   │   └── Tests/
│   ├── server/
│   │   └── src/
│   │       ├── health/               # 存活检查
│   │       └── realtime/             # /ws/client 与 /ws/web
│   └── web/
│       └── src/
│           ├── pages/
│           └── router/
├── packages/
│   └── contracts/
│       ├── envelope.schema.json      # 通用信封
│       ├── commands/                 # Server → Mac payload
│       ├── events/                   # Mac → Server payload
│       └── generated/                # 仅生成，不手工维护
├── deploy/server/                     # Docker 和本地依赖
├── docs/                              # 评估、架构和 ADR
└── scripts/                           # 仓库级自动检查
```

## 依赖方向

```text
JSON Schema ──generate──> Swift DTO ──> Mac Remote 层
      └──────generate──> TypeScript DTO ──> Server / Web

Web ──HTTP + /ws/web──> Server ──/ws/client──> Mac ──PTY──> AI CLI
```

约束如下：

1. JSON Schema 是跨语言协议的唯一事实源；`generated` 目录不接受手工业务逻辑。
2. `Session` 不依赖具体 CLI，`Tools` 通过 `CLIToolAdapter` 注入启动策略。
3. 本地终端渲染不依赖网络成功；远端输出走有界批处理和有界 Journal。
4. Web 不直接连接 Mac，不持有工作区真实路径，也不单独部署。
5. Server 只保存工作区不透明 ID；Mac 是本地路径授权的最终裁决者。

## Codex 集成决策

Codex 的结构化增强直接使用官方 App Server Protocol，不通过 `codex-acp`。Mac App 在本机
通过 stdio JSONL 管理 `codex app-server` 子进程，将原生事件转换成 TermRelay Contract；
Server 和 Web 不解析或透传 Codex 原始 JSON-RPC。所有 CLI（包括 Codex）继续保留 PTY 基础
模式，App Server 不可用或版本不兼容时在 turn 启动前回退到 PTY。

完整组件边界、通信流程、版本策略、实施清单和验收标准见
[`ADR-001-CODEX-APP-SERVER.md`](ADR-001-CODEX-APP-SERVER.md)。

## 运行时端口与信任边界

| 入口 | 调用方 | 身份要求 | 能力 |
| --- | --- | --- | --- |
| `/health` | 容器平台 | 局域网限制 | 存活检查 |
| `/api/*` | 浏览器 | 已验证的 Access JWT | 查询和命令 |
| `/ws/web` | 浏览器 | 已验证的 Access JWT | 事件订阅与终端交互 |
| `/ws/client` | Mac App | M0 为受信 LAN；公开试用前增加设备凭据 | 注册、事件与命令 |

“局域网无认证”只能作为单用户、隔离网络下的开发模式。Server 端口若能被访客 Wi-Fi、普通办公网或其他容器访问，攻击者就可能伪造设备或控制终端。

## 状态与持久化原则

- MySQL 保存设备、会话状态、命令幂等键、审批、审计和有限事件元数据；本地使用 `termrelay_dev`，最终部署使用独立的 `termrelay_prod`。
- 高频终端字节流默认只做短期环形缓冲；如需回放，采用压缩分块、TTL 和每会话配额。
- `command_id` 在 Server 和 Mac 两侧去重；`session_id + seq` 在 Server 唯一。
- 重连顺序为：注册 → 汇报每会话最后 ACK → 补传缺口 → 获取状态快照 → 恢复实时流。
- `session.state_version` 使用乐观锁，避免断线补传覆盖新状态。

## M0 与阶段 0 的分界

阶段 0 已于 2026-09-10 完成核心实机探针，结果见 `docs/MAC_STAGE0_PROBE.md`。以下能力仍需在阶段 1 持续回归：

- SwiftTerm 对中文、组合字符、全屏 TUI、鼠标和 resize 的表现。
- PTY 子进程组的 Ctrl-C、退出和 App 崩溃清理。
- 输出双路分发的延迟、背压和内存上限。
- Codex App Server 协议的版本兼容性；按 ADR-001 实施，任何启动前失败都回退到已验证的纯 PTY。
