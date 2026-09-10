# macOS 阶段 0：终端与协议探针

> 实现日期：2026-09-10
>
> 最低系统版本：macOS 14
>
> SwiftTerm：1.20.0（精确锁定）
>
> 本机 Codex CLI：0.151.0

## 结论

TermRelay Mac App 在没有 Server 的情况下作为普通本地终端运行是可行的。当前实现能够选择工作目录，在真实 PTY 中启动登录 Shell 或 Codex，并由 SwiftTerm 提供终端渲染和键盘交互。

本地终端不依赖 Server。PTY 输出先直接交给 SwiftTerm 渲染，同时复制到一个有界批处理探针；未来接入 Server 时，只需要把批处理回调替换为网络发送，不应阻塞本地显示。

## 已实现能力

- SwiftTerm AppKit 终端视图嵌入 SwiftUI。
- SwiftTerm `LocalProcessTerminalView` 提供真实 PTY 和子进程。
- 通过 `NSOpenPanel` 选择工作目录。
- 启动用户登录 Shell。
- 自动搜索并启动 Codex。
- 为 Finder 启动场景补齐 `PATH`，包括 `~/.local/bin`、Homebrew 和系统目录。
- 继承 `HOME`、认证信息及用户环境，并设置 `TERM=xterm-256color` 和 `COLORTERM=truecolor`。
- 终端键盘输入、复制粘贴、方向键和窗口 resize 交给 SwiftTerm/PTY 处理。
- 提供 Ctrl-C 和停止按钮。
- App 退出时终止受管子进程。
- 提供 10,000 行 scrollback。
- 提供 ANSI、TrueColor、中文、Emoji 和 PTY 尺寸显示探针。
- 输出以 40 ms 或 8 KiB 聚合，待发送上限为 64 KiB，并生成单调递增的 `seq`。
- 界面显示已捕获字节数、批次数和最新序列号，证明本地渲染与未来 Relay 路径同时收到输出。

## 运行方式

```bash
cd apps/mac
swift run TermRelay
```

第一次解析依赖时，需要能访问 GitHub。如果需要使用本机代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=socks5h://127.0.0.1:7890 \
swift run TermRelay
```

界面操作：

1. 点击“选择目录…”。
2. 选择“登录 Shell”或“Codex”。
3. 点击“启动”或按 Command-Return。
4. Shell 模式下点击“显示探针”，检查颜色、中文、Emoji 和 PTY 尺寸。
5. 调整窗口，运行 `stty size`，确认行列数跟随窗口变化。
6. 运行 `vim`、`top` 或 Codex，检查方向键、全屏 TUI、光标和 Ctrl-C。

## 验收矩阵

| 项目 | 实现状态 | 2026-09-10 验证状态 |
| --- | --- | --- |
| SwiftUI/AppKit App 启动 | 完成 | 主程序实际启动，可见窗口正常创建；已补 SwiftPM executable 激活策略 |
| SwiftTerm 依赖与编译 | 完成 | `swift build --disable-sandbox` 通过 |
| PTY 启动登录 Shell | 完成 | 实机启动 zsh，提示符、cwd 和输入链路正常 |
| 指定 cwd 启动 Codex | 完成 | `~/.local/bin/codex` 0.151.0 已在 PTY 中启动并产生 TUI 输出 |
| ANSI/TrueColor/中文/Emoji | 通过 | 显示探针已人工视觉确认 |
| resize | 通过 | 窗口调整后 `stty size` 从 `24 106` 更新为 `31 118` |
| 方向键/复制 | SwiftTerm 路径完成 | 发布前仍建议覆盖输入法和复制粘贴细节 |
| 全屏 TUI | 通过基础启动 | Codex TUI 已启动；复杂长会话仍需阶段 1 回归 |
| 输出双路分发 | 通过 | UI 实时渲染；Codex 启动产生 1,933 B/4 batches，`seq` 连续增长 |
| Ctrl-C 与停止 | 通过 | App Ctrl-C 使 Codex 会话从 `running` 正常进入 `finished` |
| App 退出清理 | 完成 | App Delegate 已接入终止流程 |

基础视觉、PTY、resize、Codex 启动和 Ctrl-C 已完成实机 GUI 验证。中文输入法、选择复制、鼠标报告和长时间全屏 TUI 仍应在阶段 1 作为兼容性回归项持续验证。

## Codex 协议判断

当前 Codex 0.151.0 没有名为 ACP 的 CLI 入口。它提供的是：

- 普通交互式 TUI：直接执行 `codex`，适合当前 PTY 方案。
- `codex app-server`：面向富客户端的结构化协议，支持认证、历史、审批和流式事件。
- `codex --remote`：让 Codex TUI 连接另一个 app-server WebSocket。
- `codex mcp-server`：把 Codex 作为 MCP Server 启动，与本项目所需的客户端结构化事件不是同一用途。

因此阶段 0 采用纯 PTY 是正确的默认路径。它兼容 Codex，也保持对其他 CLI 工具的通用性。后续如果要获得审批、会话历史和结构化工具事件，应新增独立的 Codex App Server Adapter，而不是从 ANSI 字节流反向解析语义。

App Server 的 WebSocket transport 目前属于实验能力。即使未来接入，也应保留 PTY 作为稳定回退路径，并按 Codex 版本生成匹配的 JSON Schema。

官方说明见 [Codex App Server](https://developers.openai.com/codex/app-server)。

## 是否需要 macOS 15

当前不需要。项目最低版本继续保持 macOS 14，原因如下：

- SwiftTerm 1.20.0 的最低 macOS 要求低于 macOS 14。
- 当前使用的 SwiftUI、AppKit、`NSOpenPanel` 和 SwiftTerm API 均可在 macOS 14 使用。
- 本机 macOS 15.6.1 构建成功不能替代 macOS 14 实机验证；发布前仍需在 macOS 14 runner 或设备上执行一次兼容性测试。

只有后续引入明确依赖 macOS 15 的系统 API 时，才应提升 Deployment Target。

## 已知限制

- 当前只有一个活动终端视图；真正的多窗口属于阶段 1。
- 没有 Server WebSocket，Relay batch 目前只进入本地统计 sink。
- 没有断线 Journal、ACK 或补传。
- Swift Package 适合原型运行，尚未生成签名 `.app`。
- 当前机器只有 Command Line Tools，没有完整 Xcode 的 `XCTest`，现有测试无法执行；主程序构建不受影响。
- App Sandbox 必须保持关闭或配置足够权限，否则普通终端无法访问用户工作区和 CLI 环境。

## 阶段 0 出口判断

阶段 0 的开发实现和核心实机探针已经完成，可以进入阶段 1。剩余的输入法、复制粘贴、鼠标和长时间 TUI 验证属于兼容性回归，不再阻塞可行性判断。
