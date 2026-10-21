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
│   ├── linux/                       # CLI / headless Agent（Ubuntu / Xubuntu）
│   │   ├── src/                     # TypeScript CLI、服务、Codex stdio、PTY 与协议
│   │   ├── native/                  # 小型 OS 进程归属 / flock supervisor
│   │   ├── tests/                   # Node 合成 Provider、真实 PTY、WebSocket 闭环
│   │   └── packaging/              # 内置 Node 的 Debian launcher 与 systemd 用户 unit
│   ├── server/
│   │   └── src/
│   │       ├── database/             # TypeORM 配置与显式 migration
│   │       ├── devices/              # 设备状态持久化与查询
│   │       ├── health/               # 存活检查
│   │       ├── realtime/             # /ws/client 与 /ws/web
│   │       └── sessions/             # 工作区、会话与有序事件
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
                              └─/ws/client──> Linux Agent ──PTY──> Shell
                                                   └─stdio──> Codex App Server
```

约束如下：

1. JSON Schema 是跨语言协议的唯一事实源；`generated` 目录不接受手工业务逻辑。
2. `Session` 不依赖具体 CLI，`Tools` 通过 `CLIToolAdapter` 注入启动策略。
3. 本地终端渲染不依赖网络成功；远端输出走有界批处理和有界 Journal。
4. Web 不直接连接 Mac，不持有工作区真实路径，也不单独部署。
5. Server 只保存工作区不透明 ID；Mac 是本地路径授权的最终裁决者。

Linux 是独立的本地进程 / 路径所有者，不经过 Mac；也可使用现有
`/ws/client-public` + 设备配对凭据接入。设备注册平台允许 `macOS` 和 `linux`，
存储沿用设备 JSON capabilities，不改变表结构。Linux CLI / 服务使用 TypeScript，
直接依赖生成的 `@termrelay/contracts` 类型 / Schema，不再维护 Python 实现。
按本地启动配置创建 Shell PTY / Codex 结构化会话，握手成功后才公布对应工具。
Codex 原始协议解析在 Linux，不进入 Server / Web；尚不公布快捷任务或 AI API 能力。
node-pty 提供真实 PTY，小型原生 supervisor 通过 Linux subreaper 跟踪并清理后代进程，
同时提供 OS flock 配置锁；Provider 协议解析仍全部在 TypeScript。
发布包按架构携带私有 Node、生产依赖与原生模块，目标机器不需要 Node / Python；
旧 GTK 入口已移除，version 1 headless 配置保持兼容。
边界、内存上限、安装与验收说明见 [`apps/linux/README.md`](../apps/linux/README.md)。

### 已确认的演进方向：无界面 Linux 与通用远程创建

Linux 主线已提供 CLI 管理 + 后台 Agent，不再要求本地 GTK / VTE UI。
沿用现有设备主动出站连接 Server 的拓扑和鉴权、路由、持久化、审批及问答语义，
用户继续通过同一个 Web / 手机入口交互；不新增 Provider 原始 ACP / JSON-RPC 公网入口。
当前 Codex 结构化会话包含轮次、配置、审批和问答映射，部署入口为 systemd 用户服务；
Linux 实机 / 真实 Provider 兼容性验收与完整功能对齐仍待完成。
启动配置不等于远程创建，也不跨重启恢复会话或内存 journal。

远程创建会话应是 macOS / Linux 共用能力：Web 提交目标设备、授权工作区、
工具和模式，Server 校验并路由，设备按自身 Runtime 创建，再统一上报会话及事件。
Mac 新会话同时进入本地 UI；Linux 无本地 UI 也应完成同样的交互闭环。
不改变普通会话与外部 AI API 会话各自的归属、审批和生命周期规则。

现有 `session.start` 仅有 PTY 导向的 Schema 草案，Mac / Linux 工作区当前均未开放远程启动，
尚不能视为端到端已实现。需要统一补齐模式校验、幂等创建、结果关联、
启动失败和未知结果处理，不能复用“目标会话必须已存在”的命令路由而跳过创建阶段。
计划和完成标准见 [U-023 / U-024](UBUNTU_APP_TODO.md)。

ACP Web 的工作区 Markdown 文件预览使用独立的 HTTP → Server → Mac WebSocket 请求/响应链路，
不经过 PTY 命令或持久化的会话事件。Server 用会话 ID 路由到设备，只临时转发文件内容；
Mac 同时验证会话、工作区 ID、真实路径边界和文件大小，拒绝工作区外的文件。

## Codex 集成决策

Codex 的结构化增强直接使用官方 App Server Protocol，不通过 `codex-acp`。Mac App 在本机
通过 stdio JSONL 管理 `codex app-server` 子进程，将原生事件转换成 TermRelay Contract；
Server 和 Web 不解析或透传 Codex 原始 JSON-RPC。所有 CLI（包括 Codex）继续保留 PTY 基础
模式，App Server 不可用或版本不兼容时在 turn 启动前回退到 PTY。

完整组件边界、通信流程、版本策略、实施清单和验收标准见
[`ADR-001-CODEX-APP-SERVER.md`](ADR-001-CODEX-APP-SERVER.md)；通用接口、能力模型、事件、
生命周期和新智能体接入规范见
[`STRUCTURED_AGENT_ADAPTER_DESIGN.md`](STRUCTURED_AGENT_ADAPTER_DESIGN.md)。

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
- 高频终端字节流只允许短期保留。S3 使用带 TTL 的 Base64 事件实现首个闭环；进入生产前仍需压缩分块、物理清理和每会话配额。
- `command_id` 在 Server 和 Mac 两侧去重；`session_id + seq` 在 Server 唯一。
- Server 持久记录 ACP 会话是否收到过用户消息；无用户消息的 ACP 会话在结束、设备断联或 Server 启动清理残留会话时，连同事件、命令和审批记录一并永久删除。PTY 和已有用户消息的 ACP 会话保留原有删除流程。
- 重连顺序为：注册 → 汇报每会话最后 ACK → 补传缺口 → 获取状态快照 → 恢复实时流。
- `session.state_version` 使用乐观锁，避免断线补传覆盖新状态。
- Browser 只订阅目标 Session：先通过 HTTP 加载历史，再携带最后 seq 建立 `/ws/web` 订阅；Server 在快照期间缓冲实时事件，浏览器按 seq 去重。
- Web 的 input、resize、interrupt 和 stop 必须携带 `command_id`；Server 验证 Session/Device 归属与在线连接后定向转发，Mac 执行 PTY 操作并以 `command.ack` 返回结果。
- Mac 网络层使用系统 `URLSessionWebSocketTask`，注册成功后才同步工作区/Session；尚未发送的终端批次最多在内存保留 16 MiB，重连并重新声明 Session 后按 seq 发送。

## Mac-owned shortcuts (server slice)

- A registered Mac publishes a full `shortcut.catalog` snapshot (up to 100 entries). The server persists only names, descriptions, opaque workspace IDs, revision and display/confirmation metadata; it never stores shortcut commands, local paths or proxy endpoints.
- Web polls `GET /api/shortcuts` and `GET /api/shortcuts/runs/:runId`. Starting a run uses `POST /api/shortcuts/:id/runs` with a caller-generated UUID `runId`; cancelling uses `POST /api/shortcuts/runs/:runId/cancel`. The server sends `shortcut.run.start` (`runId`, `shortcutId`, `revision`) or `shortcut.run.cancel` (`runId`) only to the registered device.
- A cancel request does not mark a run cancelled: only the Mac's `shortcut.run.update` does. Only server-requested runs have IDs in this API; Mac-local trial runs are not reported to the server. Output is a replacement snapshot bounded to 32768 characters; burst running snapshots coalesce to at most one write per 250 ms per run, while terminal updates flush the latest snapshot immediately. A short run may go directly from `queued` to `succeeded` or `failed`. Terminal runs reject all later updates, including delayed `running` messages. One queued/running run per shortcut is permitted. On disconnect or server restart, active runs transition to `failed` with `连接中断，执行结果未知；请核实后再运行`: this is **not** evidence that the Mac subprocess stopped. They are never automatically retried. Completed runs remain pollable for 30 days after their last update, then are pruned at startup and daily; active runs are not pruned.

## M0 与阶段 0 的分界

阶段 0 已于 2026-09-10 完成核心实机探针，结果见 `docs/MAC_STAGE0_PROBE.md`。以下能力仍需在阶段 1 持续回归：

- SwiftTerm 对中文、组合字符、全屏 TUI、鼠标和 resize 的表现。
- PTY 子进程组的 Ctrl-C、退出和 App 崩溃清理。
- 输出双路分发的延迟、背压和内存上限。
- Codex App Server 协议的版本兼容性；按 ADR-001 实施，任何启动前失败都回退到已验证的纯 PTY。
