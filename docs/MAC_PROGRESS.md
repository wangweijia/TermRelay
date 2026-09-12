# TermRelay macOS 端任务进展

> 评估日期：2026-09-12
>
> 当前阶段：PTY 多会话闭环完成，Codex TUI/结构化审批合并运行时已实现
>
> 评估范围：`apps/mac` 现有源码、测试、项目规划及 Git 提交记录

## 总体结论

macOS 端已经完成本地终端、Server WebSocket 闭环和同一 App 窗口内的多 Session。每个
Shell Session 拥有独立 PTY；每个 Codex Session 拥有独立 App Server、Unix Socket、Thread、
PTY TUI 和结构化监听连接。侧边栏可独立切换和停止；独立 macOS 原生窗口仍未实现。

- 工程骨架完成度：约 40%。
- Mac MVP 功能完成度：约 25%～30%。
- 当前可实际使用程度：可作为单窗口本地终端原型使用。
- 当前可以完成：选择目录、启动登录 Shell/Codex、PTY 交互、终端渲染、Ctrl-C、停止及输出批处理探针。
- 当前无法完成：结构化 Agent 的 Server/Web 跨端交互、无歧义断线补传和正式签名分发。

以上比例是基于当前规划任务数量和关键路径权重的工程估算，不是正式验收数据。

## 已完成内容

### 1. macOS 工程骨架

- 已建立 Swift 6 Package。
- 最低目标平台为 macOS 14。
- 已建立 SwiftUI `App` 入口、主窗口和设置窗口。
- `swift build` 已于 2026-09-10 验证通过。

相关文件：

- `apps/mac/Package.swift`
- `apps/mac/Sources/AppShell/TermRelayApp.swift`

### 2. 基础 SwiftUI 界面

主界面当前包括：

- TermRelay 标题。
- 连接状态指示。
- 设置入口。
- 无会话时的空状态页面。

已经提供目录选择、Shell/Codex 工具选择、启动、Ctrl-C、停止和真实终端视图。当前仍为单活动终端，多窗口属于阶段 1。

相关文件：`apps/mac/Sources/AppShell/ContentView.swift`。

### 3. Server 设置与设备 ID

已实现：

- Server WebSocket URL 输入框。
- Server URL 通过 `UserDefaults` 持久化。
- 首次启动生成随机 `device_id`。
- 后续启动复用已保存的 `device_id`。
- 设置页展示 Device ID 和“重新连接”按钮。

当前“重新连接”按钮只把 UI 状态更新为 `connecting`，不会创建 WebSocket 或发起真实连接。

相关文件：

- `apps/mac/Sources/AppShell/AppModel.swift`
- `apps/mac/Sources/AppShell/ServerSettingsView.swift`

### 4. 连接状态模型

已定义以下连接状态以及对应显示颜色：

- `connected`
- `connecting`
- `offline`
- `degraded`

这些状态目前没有接入真实网络连接生命周期。

相关文件：`apps/mac/Sources/Remote/ConnectionState.swift`。

### 5. 会话模型和状态机

`ManagedSession` 当前包含：

- 会话 UUID。
- 工作目录 URL。
- CLI 工具 ID。
- 会话状态。

已实现以下合法状态转换：

```text
starting → running → stopping → finished
    └───────────────→ failed
```

阶段 0 的 `LocalTerminalSession` 已关联 SwiftTerm PTY、终端视图、输出批处理和进程生命周期；原有 `ManagedSession` 仍需在阶段 1 与多窗口状态统一。

相关文件：`apps/mac/Sources/Session/ManagedSession.swift`。

### 6. 终端与 CLI 工具抽象

已定义：

- `TerminalRenderer`：接收终端字节和尺寸变化。
- `CLIToolAdapter`：为 CLI 工具生成启动配置。
- `LaunchConfiguration`：描述可执行文件、参数、目录和环境变量。

已增加 SwiftTerm/PTY 实现、登录 Shell Adapter、CodexAdapter、可执行文件搜索和终端环境构造。

相关文件：

- `apps/mac/Sources/Terminal/TerminalRenderer.swift`
- `apps/mac/Sources/Tools/CLIToolAdapter.swift`

### 7. 初始单元测试

已编写两个 `ManagedSession` 状态机测试：

- 正常状态转换。
- 已结束会话不能重新运行。

2026-09-10 验证时，当前系统只选择了 `/Library/Developer/CommandLineTools`，工具链找不到 `XCTest`，因此测试未能执行。Mac 主程序本身已经构建成功；该问题属于本机测试工具链配置，不是测试断言失败。

相关文件：`apps/mac/Tests/ManagedSessionTests.swift`。

## 分阶段进度

### 阶段 0：终端与协议探针

| 工作项 | 状态 | 备注 |
| --- | --- | --- |
| 建立最小 SwiftUI/AppKit macOS App | 完成 | 主程序已构建并实际启动 |
| 集成 SwiftTerm | 完成 | 精确锁定 1.20.0 |
| 使用 PTY 在指定目录启动 Codex | 完成 | Codex 0.151.0 已在真实 PTY 中启动并输出 TUI |
| 验证颜色、中文、resize 和全屏 TUI | 完成核心验证 | ANSI、TrueColor、中文、Emoji、resize 和 Codex TUI 已实机验证 |
| 验证 PTY 输出分流至本地终端和 Relay 路径 | 完成 | 本地即时渲染；40 ms/8 KiB、64 KiB 上限、seq 统计 |
| 验证 Codex 结构化协议能力 | 完成评估 | 当前应使用 App Server 协议而非 ACP；阶段 0 保持纯 PTY |

阶段 0 已完成。实机结果和后续兼容性回归项见 `docs/MAC_STAGE0_PROBE.md`。

### 阶段 1：Mac App 单机功能

| 工作项 | 状态 | 备注 |
| --- | --- | --- |
| Server URL 设置 | 已完成 | 已持久化、校验并用于实际 WebSocket 连接 |
| Device ID 持久化 | 已完成 | 使用 `UserDefaults` |
| 自动连接和设备注册 | 已完成 | 支持注册、心跳和指数退避重连 |
| NSOpenPanel 目录选择 | 已完成 | 当前用于单活动终端 |
| CLI 工具选择器 | 已完成 | 支持登录 Shell 和 Codex |
| CodexAdapter | 基础完成 | 支持检测、环境构造和 PTY 启动 |
| 多窗口和 ManagedSession | 部分完成 | 同一 App 窗口支持多个独立 PTY Session 并通过侧边栏切换；尚无独立 macOS 窗口 |
| 菜单栏驻留 | 未实现 | 无 `MenuBarExtra` 或 AppKit 生命周期管理 |
| 退出确认和进程清理 | 部分完成 | App 退出会终止进程，尚无会话数量确认框 |
| 本地终端输入、停止和恢复 UI | 部分完成 | 输入、Ctrl-C、停止已完成；恢复未实现 |
| 按工具配置启动代理 | 已完成 | 支持继承、禁用、自定义；同时注入大小写 HTTP/HTTPS/ALL/NO_PROXY |
| 按工具配置可执行路径 | 已完成 | 设置页可输入或选择文件；留空时继续从 PATH 和常用目录查找 |

### 阶段 2：Server 与 Mac App 闭环

以下 Mac 侧能力已经完成：

- WebSocket 建连与自动重连。
- `device.register` 和心跳。
- 会话注册和状态同步。
- 终端输出上传。
- 远程输入、resize、中断和停止。
- 基于 `session_id` 的命令路由。
- `command_id` 幂等处理。
- 输出 `seq` 和有界内存缓存。

仍未完成：Server 事件 ACK、持久化 EventJournal 和无歧义断线补传。

共享协议中已有部分 Swift 生成类型，但尚未接入 Mac Remote 层。

### 阶段 3：管理页面联动

Mac 与管理页面的实时终端已完成。结构化 Agent 最小纵向闭环也已接通：Mac 可创建
Codex App Server 会话，Web 可发起/中断 Turn、查看归一化事件并执行“仅允许一次/拒绝”审批。
尚缺 Server event ACK、Mac 磁盘 Journal 和断线窗口的无歧义补传。

### 结构化 Agent 当前进度

- AgentCore、capability、action、event、状态机和错误边界已建立。
- FakeAgentAdapter 已验证 turn、审批关联、事件序号和幂等停止。
- Codex App Server stdio Process 与 JSON-RPC 请求关联、超时和反向 request 已实现。
- `codex-cli 0.153.4` 的真实 `initialize` 与 ephemeral `thread/start` 已通过，无模型调用。
- 已映射助手/reasoning/plan 增量、命令、文件变化、审批、turn completion 和 error。
- 审批仅提供单次允许和拒绝；停止、未知请求和关联不匹配均不会自动批准。
- `LocalStructuredAgentSession` 已接入 App 会话列表与本地 UI，Terminal/Structured runtime 可并存。
- `tool.event`、`tool.turn.start`、`tool.turn.interrupt`、`tool.approval.resolve` 已接入 RemoteClient。
- Codex PTY 与 Codex App Server 使用同一份按工具代理配置快照；配置仅作用于新会话。
- 新建会话只选择 Shell/Codex；Codex 的底层结构化 runtime 不再作为一级 UI 选项。
- Codex 可选择 Web“仅审批/终端完整流”，两种模式都持续接收结构化审批事件。
- 每个 Codex 会话独占 App Server Unix Socket、Thread、PTY TUI 和 TermRelay JSONL 监听连接。
- TUI 使用 `codex resume --remote unix://...` 进入监听端创建的同一 Thread；多会话互不影响。
- 已用 Codex CLI 0.153.4 实测第二客户端可收到 TUI 发起的 turn、命令和审批 request。
- Codex 会话的终端输出与结构化事件使用统一、稳定的 Relay 序号及同一断线内存队列。

### 阶段 4：发布与加固

以下产品化工作尚未开始：

- 正式 Xcode App 工程及 Release 配置。
- App Sandbox 与 entitlement 设计。
- Keychain 秘密管理。
- GRDB/SQLite 本地数据存储。
- App 图标和正式菜单。
- Developer ID 签名与 Apple 公证。
- 安装包或自动升级方案。
- 崩溃恢复和生产日志。

## 当前运行效果

当前运行 Mac App 时，可以：

1. 打开 TermRelay 主窗口。
2. 选择本地工作目录。
3. 选择并启动登录 Shell 或 Codex。
4. 在 SwiftTerm 中进行 PTY 终端交互。
5. 发送 Ctrl-C 或停止进程。
6. 查看 Relay 输出批次、字节数和序列号探针。
7. 进入设置页修改 Server URL 并查看 Device ID。

当前已能连接 Server、同步多个会话，并从 Web 发送终端输入、resize、Ctrl-C、停止及 Codex
审批响应。生产级断线 Journal、持久化命令状态和压力测试仍未完成。

## MVP 验收情况

PTY 和结构化审批的最小纵向闭环已经形成并通过自动化测试；Codex 0.153.4 的双客户端
App Server 行为已实测。仍需 GUI 人工回归多 Codex 会话、远程审批后 TUI 状态同步，以及断网
恢复期间的完整性。

## 下一步优先级

1. 为 Server ACK 和 Mac EventJournal 增加落盘与重连续传，替换当前有界内存队列。
2. 将命令 ACK 状态持久化，覆盖超时、断线重连和重复 ACK。
3. 增加终端事件物理过期清理与单会话存储配额。
4. 实测两个以上并发 Codex 组合会话、远程审批、长输出和慢浏览器背压。
5. 从 JSON Schema 自动生成 Swift/TypeScript DTO，并在 CI 检查漂移。
6. 完善结构化 Agent 的审计、恢复、通知和更多审批类型。

## 维护方式

后续每次推进 Mac 端任务时，应同步更新：

- 文档顶部的评估日期和当前阶段。
- 对应任务表中的状态及备注。
- 已通过的构建、测试和实机探针结果。
- 新发现的阻塞项和下一步优先级。
- ADR-001 开发清单、受测 Codex 版本和 App Server Schema fixture。
