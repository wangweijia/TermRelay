# Codex App Server 原生 UI 重构计划

> 状态：已完成（2026-09-13）
>
> 编写日期：2026-09-13
>
> 依据：`TermRelay 使用 Codex App Server（Unix Socket）实现说明.md`、当前 TermRelay 代码、Codex CLI 0.154.0 生成的 App Server JSON Schema，以及 [OpenAI Codex App Server 官方文档](https://developers.openai.com/codex/app-server)。

## 1. 目标

把目前的 Codex “PTY TUI + App Server 协议代理”混合实现彻底拆成两个互斥模式：

```text
Codex
├── PTY
│   ├── 启动普通 codex CLI
│   ├── Mac 使用 SwiftTerm
│   └── Web 使用 xterm.js/当前 TerminalView
└── ACP（Codex App Server）
    ├── 每个会话启动独立 codex app-server
    ├── 每个会话使用独立 Unix Socket
    ├── TermRelay 是唯一协议 Client
    ├── 不启动 codex --remote
    ├── 不创建 PTY
    ├── Mac 使用 SwiftUI 原生会话页
    └── Web 使用 Vue 原生会话页
```

重构完成后，App Server 模式中不得出现：

- `codex --remote`
- Codex TUI
- ANSI/终端帧
- `terminal.input`、`terminal.resize`、Ctrl-C 等终端命令
- 为了监听同一 Thread 而建立的第二协议客户端
- TUI 断线后生成的 `resume` 提示

App Server 模式由 TermRelay 直接执行：

```text
spawn app-server
→ connect Unix Socket
→ initialize / initialized
→ thread/start
→ turn/start
→ fold notifications into SessionStore
→ render native UI
→ answer approvals / user-input requests
→ interrupt or stop
```

## 2. 当前实现与目标的差距

当前代码已经有结构化 Agent 的基础层，但 Codex 路径仍是混合架构：

- `AppModel.startStructuredSession()` 同时创建 `CodexAppServerHost` 和 `LocalTerminalSession`。
- `CodexAdapter.makeNewRemoteSessionLaunchConfiguration()` 仍启动 `codex --remote`。
- `CodexProtocolRelay` 和 `UnixWebSocketServerTransport` 把 TUI 放在 App Server 连接中间。
- `pendingCodexTerminals` 用于等待 TUI 创建 Thread。
- Mac 的结构化页面按原始 `ToolEvent` 一行一行渲染，没有稳定的消息、命令、文件和审批模型。
- Web 的 `StructuredAgentView` 在 `full` 模式下仍嵌入 `TerminalView`，结构化事件只筛选审批、警告和错误。
- `webDisplayMode = approval | full` 是混合架构遗留；纯 App Server 模式不再需要“终端完整流”。
- 协议只覆盖最小的 assistant/reasoning/command/file/approval 事件，未覆盖 `item/tool/requestUserInput`、网络审批、可用审批决策、patch 增量等原生交互所需信息。
- Mac 和 Web 都直接消费事件数组，没有共享的、可重放的投影规则。

因此这次不是在现有 relay 上修补，而是删除 TUI relay 分支，让现有 `CodexAppServerClient` 成为 App Server 模式唯一连接。

## 3. 目标领域模型

### 3.1 会话选择

新建会话的选择层级调整为：

```text
工具
├── Shell
└── Codex
    └── 交互模式
        ├── PTY
        └── ACP（Codex App Server）
```

建议引入独立类型，而不是继续让 `selectedTool == .codex` 隐式代表结构化模式：

```swift
enum CodexInteractionMode: String, Codable, CaseIterable, Sendable {
    case pty
    case acp
}
```

`Shell` 只允许 PTY；`Codex` 才显示二级模式选择。会话创建逻辑显式分派：

```text
Shell              → startPTYSession(tool: shell)
Codex + PTY        → startPTYSession(tool: codex)
Codex + App Server → startCodexAgentSession()
```

### 3.2 Runtime

一个 App Server 会话对应一个独立 Runtime：

```text
CodexAgentSession
├── runtimeId
├── workingDirectory
├── runtimeDirectory
├── socketPath
├── appServerProcess
├── connection
├── threadId
├── activeTurnId
├── state
└── SessionStore
```

Runtime 状态建议细化为：

```text
created
startingProcess
waitingForSocket
connecting
initializing
startingThread
ready
running
waitingForApproval
waitingForUserInput
interrupting
stopping
stopped
failed
```

对外的 Server 会话状态仍可折叠为：

```text
starting | running | stopping | finished | failed
```

### 3.3 SessionStore

SwiftUI 不直接读取 Codex JSON-RPC，也不直接把 delta 当列表行。新增可观察的聚合状态：

```swift
struct AgentConversationState {
    var messages: [AgentMessage]
    var activities: [AgentActivity]
    var pendingApprovals: [AgentApproval]
    var pendingQuestions: [AgentQuestion]
    var plan: AgentPlan?
    var activeTurn: AgentTurn?
    var runtimeState: AgentRuntimeState
    var error: AgentPresentationError?
}
```

其中：

- user message 在本地接受输入后立即插入，之后用 command id 去重。
- assistant delta 按 `turnId + itemId` 合并到同一条消息。
- reasoning summary 按 item 合并，可折叠显示。
- command output 按 command item 合并，不为每个 delta 新增列表项。
- file change 保存文件路径、变更类型、patch/输出和最终状态。
- approval 和 request-user-input 是独立、可操作的卡片。
- completed item 是权威最终值；delta 只负责流式体验。

Mac 与 Web 不共享 UI 代码，但必须使用同一套事件折叠语义。Swift 侧实现 `AgentSessionStore`，TypeScript 侧实现等价的纯函数 projector，并用同一组 JSON fixtures 验证结果一致。

## 4. App Server Runtime 设计

### 4.1 进程与目录

每个 Runtime 创建持久元数据目录：

```text
~/Library/Caches/TermRelay/runtime/<runtime-id>/
└── runtime.json
```

Unix socket 不建议无条件与 `runtime.json` 放在一起。macOS `sockaddr_un.sun_path` 长度有限，沙箱容器下的 Cache 路径很容易超限。建议：

```text
metadata: ~/Library/Caches/TermRelay/runtime/<runtime-id>/runtime.json
socket:   一个经过长度校验的短临时路径/tr-<short-id>.sock
```

Runtime 元数据记录真实 socket 路径。启动前只清理由本次新 Runtime 创建且确认无存活 owner 的路径，不删除未知 socket。

进程命令：

```bash
codex app-server --listen unix://<unique-socket-path>
```

不再启动 `codex app-server proxy`，不再启动第二个 relay socket。

### 4.2 连接

保留并收敛现有组件职责：

- `CodexAppServerProcess`：只负责 App Server 进程、stderr、PID 和退出状态。
- `CodexUnixSocketConnection`：直接完成 Unix Socket 上的 HTTP Upgrade、WebSocket frame 编解码、JSON-RPC 收发。
- `CodexAppServerClient`：请求 id、pending continuation、超时、通知和 server request 分发。
- `CodexStructuredRuntime`：协议到 TermRelay 领域事件的映射。

当前通过 `codex app-server proxy --sock` 绕到 stdio 的连接应替换为真正的 Swift Unix Socket Client，避免再依赖一个 Codex proxy 子进程，也让 Runtime 的 PID/失败边界明确。

连接成功的判定必须依次满足：

```text
process alive
socket exists
Unix connect succeeds
WebSocket upgrade succeeds
initialize succeeds
initialized sent
```

Socket 文件存在只代表可以尝试连接，不代表 Runtime ready。

### 4.3 Thread

初始化完成后由 TermRelay 直接调用一次 `thread/start`：

```json
{
  "method": "thread/start",
  "params": {
    "cwd": "<working-directory>",
    "approvalPolicy": "on-request",
    "sandbox": "workspaceWrite",
    "serviceName": "termrelay"
  }
}
```

保存响应中的 `thread.id` 和 `thread.sessionId`。不等待外部 TUI 创建 Thread，不调用 `thread/loaded/list` 猜测 Thread。

首版维持：

```text
1 TermRelay session = 1 Runtime = 1 App Server = 1 Thread
```

### 4.4 Turn 与输入仲裁

Mac 和 Web 都可以发起 `tool.turn.start`，但同一时刻只允许一个 active turn：

- `ready` 时 composer 可发送。
- `running` 时 composer 禁用，保留“中断”按钮。
- 同时到达的第二个 start 命令由 Mac runtime 原子拒绝为 `turn_already_running`。
- `clientUserMessageId` 使用 Relay command id，保证断线重发不重复创建用户消息或 Turn。
- Steering 暂不进入首版；若后续启用，单独增加 `tool.turn.steer`，不复用 start。

### 4.5 Server requests

首版原生 UI 至少覆盖：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

所有请求保存原始 RPC id 与 `threadId/turnId/itemId` 关联，只允许一次完成。Mac 与 Web 同时操作时，以 Mac runtime 收到的第一份有效 response 为准；之后的点击返回明确的 `approval_already_resolved` 或 `request_already_resolved`。

不要把未知 server request 自动批准。未知请求进入阻塞错误卡片，并返回受控的 JSON-RPC error 或等待用户升级客户端，具体按该 Codex 版本 schema 决定。

## 5. TermRelay 规范化事件

现有 `tool.event` 保留作为 Server 持久化和断线重放的基础，但扩充并收紧 payload。建议事件集：

```text
runtime.state.changed
thread.started
turn.started
user.message
assistant.message.delta
assistant.message.completed
reasoning.summary.delta
reasoning.summary.completed
plan.updated
command.started
command.output.delta
command.completed
file.change.started
file.change.delta
file.change.completed
approval.requested
approval.resolved
user_input.requested
user_input.resolved
turn.completed
warning
error
```

关键规则：

- 所有会改变已有 UI item 的事件必须带稳定 `itemId`。
- 用户操作必须带 `commandId` 或等价 idempotency key。
- `turn.completed` 不能代替 item completed；二者分别落库。
- App Server 原始 JSON 不直接透传给 Web，避免协议版本变化污染产品契约。
- 对未知 Codex notification 可记诊断日志，但不进入用户事件历史。
- 单条输出设置大小上限；大 command output 分块保存并在 UI 中虚拟化/折叠。

需要同步修改：

- `packages/contracts/events/tool-event.schema.json`
- 新增 `tool-user-input-resolve` command schema
- Swift/TypeScript generated contracts
- Mac `RelayProtocol` 编解码
- Server validators、gateway、持久化测试
- Web types 和 store

## 6. Mac 原生 UI

### 6.1 新建会话页

当工具为 Codex 时显示二级 segmented picker：

```text
[ PTY ] [ App Server/ACP ]
```

移除当前“Web 展示：仅审批 / 终端完整流”选项。App Server 模式在 Mac 和 Web 都始终是完整的原生活动流。

### 6.2 会话页

用 SwiftUI 组件组合，不嵌入 SwiftTerm：

```text
Toolbar
├── 会话名 / 工作目录
├── Runtime 状态
├── Thread/Turn 简短状态
├── 中断
└── 停止

ScrollViewReader + LazyVStack
├── UserMessageBubble
├── AssistantMessageBubble (Markdown/text)
├── ReasoningDisclosure
├── PlanCard
├── CommandCard
│   ├── command / cwd
│   ├── running/completed/failed
│   ├── streamed output
│   └── exit code
├── FileChangeCard
├── ApprovalCard
└── UserInputCard

Composer
├── multiline TextEditor
├── Send
└── running 时 Interrupt
```

UI 行为：

- delta 更新现有 cell，不新增 cell。
- 自动滚动只在用户位于底部附近时发生；用户向上阅读时不抢滚动位置。
- command output 默认限制高度，可展开、复制。
- reasoning 默认折叠。
- pending approval/question 固定有明显状态，完成后按钮禁用并显示结果。
- 启动和失败状态使用原生 progress/error view。
- `Cmd+Enter` 发送，`Esc` 或工具栏按钮中断；普通 Enter 保留换行。

### 6.3 AppModel 拆分

`AppModel` 不再直接拼装 Codex Process、Host、Terminal 和 Runtime。新增 `CodexRuntimeManager`，`AppModel` 只负责：

- 保存会话集合与选择配置。
- 调用 manager 创建/停止 Runtime。
- 把 Runtime 的规范化事件交给 `RemoteClient`。
- 暴露 `AgentSessionStore` 给 SwiftUI。

删除：

- `pendingCodexTerminals`
- `startNewCodexTUI`
- App Server 模式下的 `LocalTerminalSession`
- App Server 模式下的 terminal input/resize 路由

## 7. Web 原生 UI

### 7.1 页面分流

```text
PTY session       → TerminalView
App Server session → AgentConversationView
```

`AgentConversationView` 不再 import 或嵌入 `TerminalView`。

### 7.2 组件

建议拆成：

- `AgentConversationView.vue`
- `AgentMessage.vue`
- `AgentCommandCard.vue`
- `AgentFileChangeCard.vue`
- `AgentApprovalCard.vue`
- `AgentUserInputCard.vue`
- `AgentComposer.vue`
- `useAgentProjection.ts`

复用现有 CSS 设计语言和 Vue 组件方式，不引入新的 UI 框架。滚动列表用当前 Vue 能力实现；数据量达到阈值后再引入虚拟列表依赖。

### 7.3 Web 交互

Web 发送的仍是 TermRelay 命令，不直连 Codex：

```text
Web UI
→ Server WebSocket
→ Mac RemoteClient
→ Codex Runtime
→ App Server
```

支持：

- 发送 prompt
- 中断 active turn
- 停止整个 session
- 处理审批
- 回答 `requestUserInput`
- 断线后从 Server 事件历史重建完整 UI

Web 不发送 terminal input/resize 到 App Server 会话。所有按钮根据 session、turn、approval/question 状态独立禁用，不能只依赖 device online。

## 8. Server 与数据库

Server 继续只做 Relay、校验、顺序化与事件持久化，不接触本机 Codex socket。

计划修改：

- session started payload 明确记录 Codex 交互模式。
- 移除或废弃 `webDisplayMode`。
- validators 阻止 PTY 命令发往 App Server session，也阻止 Agent 命令发往 PTY session。
- 新增回答用户问题的 command。
- command ack 保留幂等语义和明确错误码。
- 事件历史仍按 session sequence 单调排序；同一来源重发必须去重。
- 为旧 `terminal/structured` 数据提供数据库迁移或兼容读取，具体取决于“命名”决策。

不建议 Server 保存 Codex 原始 RPC id 以外的 provider 私有状态；需要审批关联时只保存不可执行的 opaque id 和规范化展示数据。Codex 凭据、socket 路径和本机 PID 不上传 Server。

## 9. 生命周期与恢复

### 9.1 正常关闭

```text
reject new actions
→ resolve/cancel pending UI operations according to policy
→ interrupt active turn (bounded timeout)
→ close protocol connection
→ terminate app-server
→ wait for process exit
→ escalate termination if necessary
→ remove owned socket
→ mark runtime stopped
→ publish session ended
```

每一步必须幂等；窗口关闭、远程停止和 App 退出走同一条 stop 路径。

### 9.2 异常退出

Runtime 进程退出时立即：

- 关闭连接并失败所有 pending request。
- Runtime 进入 failed。
- 生成规范化 error event。
- Mac/Web 停用 composer 和审批按钮。
- 保存 stderr 的脱敏尾部用于本机诊断。

### 9.3 App 启动恢复

首版不接管遗留 App Server；只清理通过 runtime metadata、精确命令行参数和受限 socket 命名确认属于 TermRelay 的资源：

- 扫描 `runtime.json`。
- 验证 PID identity，而不只用 `kill(pid, 0)`。
- 已死亡进程的 owned runtime 标记为 stale 并清理。
- 仍存活但无法证明 ownership 的进程不 kill、不删除 socket，记录诊断并隔离。
- 新会话始终使用新 runtime id。

是否支持恢复旧 Thread/旧 App Server，留作单独阶段，不与本次 UI 重构绑定。

## 10. 文件级实施顺序

### Phase 0：冻结契约与命名

- 确认 UI 名称：`ACP` 还是 `App Server`。
- 确认 wire/database 的 mode 值与旧数据迁移策略。
- 确认正常关闭时 Thread 保留还是删除。
- 确认首版恢复策略。
- 生成并保存当前支持的 Codex schema fixture/版本元数据。

完成条件：本文件“待协商项”全部有结论。

### Phase 1：拆除 TUI 混合架构

- 删除 `CodexProtocolRelay.swift`。
- 删除 `UnixWebSocketServerTransport.swift`。
- 删除 `pendingCodexTerminals` 和 `startNewCodexTUI()`。
- 删除 `CodexAdapter` 的 remote TUI launch API。
- 将 Codex PTY 路径恢复为普通 `CodexAdapter.makeLaunchConfiguration()`。
- App Server 路径只创建 structured runtime。

完成条件：代码中 App Server 模式没有 `--remote`，PTY 模式没有 App Server Process。

### Phase 2：独立 Runtime 与直接 Unix Socket Client

- 新增 Runtime directory/metadata abstraction。
- 拆分 process manager 与 direct Unix WebSocket connection。
- 完成 readiness、PID、stderr、termination、owned-path cleanup。
- `CodexAppServerClient` 直接连接唯一 socket。
- 实现 `initialize → initialized → thread/start`。

完成条件：无 TUI、无模型调用的真实 integration test 能得到新 thread id，并能干净关闭。

### Phase 3：领域事件与 SessionStore

- 扩充 `ToolEventPayload`。
- 实现 Codex notification/server request mapper。
- 实现 Swift `AgentSessionStore` projector。
- 实现共享 JSON fixtures。
- 覆盖 delta 合并、completed 覆盖、乱序/重复保护。

完成条件：录制的协议 fixture 可重放成稳定会话视图。

### Phase 4：Mac 原生 UI

- 新建会话二级模式选择。
- 完整原生 conversation/activity/composer 页面。
- 审批、request-user-input、中断和停止交互。
- 辅助功能、键盘操作、滚动行为和长输出处理。

完成条件：Mac 上 App Server 模式全程不出现终端 UI，能够完成至少一个含命令与审批的 Turn。

### Phase 5：Relay 契约与 Server

- 更新 JSON Schema 和生成代码。
- 更新 protocol validators/gateways/service。
- 更新数据库兼容或迁移。
- 保证重连、历史分页、seq 去重和 command ack。

完成条件：PTY 与 App Server 命令不可串路，Server 测试覆盖新事件和错误路径。

### Phase 6：Web 原生 UI

- 用 projector 从事件历史构建 view model。
- 替换当前 `StructuredAgentView` 的 TerminalView 分支。
- 实现消息、活动、审批、问题和 composer 组件。
- 实现断线重建与双端操作冲突反馈。

完成条件：浏览器刷新后可从持久化事件恢复与 Mac 一致的会话视图并继续交互。

### Phase 7：生命周期、恢复与文档收尾

- 统一 stop state machine。
- stale runtime 扫描与安全清理。
- 真实多 Runtime 并行测试。
- 更新 ADR、进度文档、用户说明。
- 删除旧 `webDisplayMode` 和兼容代码（若迁移窗口已结束）。

完成条件：多窗口互不串线，关闭无孤儿进程/owned socket，崩溃残留不会误删活进程资源。

## 11. 测试计划

### 单元测试

- JSON-RPC request/response/notification 分类与关联。
- Unix WebSocket 握手、mask、fragment、ping/pong、close、大小限制。
- Runtime 状态机合法/非法转换。
- Thread/Turn id 关联。
- assistant/reasoning/command/file delta 合并。
- completed item 覆盖流式临时值。
- approval available decisions 与一次性完成。
- user-input 单选、多选、自由文本和超时。
- command idempotency 与重复事件去重。
- unknown server request fail-closed。

### Mac 集成测试

- `codex app-server --listen unix://<unique>` 真实 initialize/thread-start 探针。
- 两个 Runtime 同时启动、Thread 不串线。
- 一个 Runtime 退出不影响另一个。
- 无 `codex --remote`/PTY 子进程。
- App 关闭后 owned process/socket 被清理。

真实探针默认跳过，用显式环境变量启用，且不自动发起计费模型 Turn。

### Server/Web 测试

- contracts schema check 与生成文件一致。
- mode-aware command validation。
- event persistence、分页、重连补传和去重。
- projector fixture parity。
- Vue component tests：composer、流式合并、approval、question、interrupt、offline。
- 端到端：Mac fake runtime → Server → Web 原生 UI → command response。

### 验收场景

1. Codex + PTY：行为与现有普通 Codex 终端一致。
2. Codex + App Server：Mac 只显示原生列表和输入组件。
3. Web 打开同一 App Server 会话：只显示原生 Agent UI，不创建 xterm。
4. Mac/Web 任一端发送 prompt，另一端实时看到同一用户消息和流式回复。
5. 命令/文件审批两端同时出现；一端处理后另一端立即失效并显示结果。
6. request-user-input 可以在任一端完成。
7. 中断后状态回到 ready，可继续下一 Turn。
8. 多个 App Server 会话拥有不同 PID/socket/threadId，互不影响。
9. 关闭一个会话不出现 Codex TUI reconnect/resume 文案。
10. Web 刷新或短暂断线后，从历史事件恢复相同视图。

## 12. 已确认决策

用户已于 2026-09-13 确认以下结论，实施不再保留兼容分支。

### A. “ACP”命名是否只作为 UI 俗称

Mac、Web、wire 和数据库统一使用 `PTY / ACP`；ACP 的实现副标题注明 Codex App Server。

### B. Socket 与 runtime.json 是否必须同目录

文档建议二者位于 Cache runtime 目录，但完整 macOS Cache 路径可能超过 Unix socket 路径上限。我认为严格同目录不稳妥。

建议：元数据放 Cache；socket 放长度校验后的短临时路径，并在 `runtime.json` 引用它。若未来 App Sandbox 不允许 `/private/tmp`，再使用容器内可连接且满足长度限制的最短目录。

结论：接受元数据与 socket 分离；元数据进入 Cache，socket 使用经过长度校验的短临时路径。

### C. 关闭窗口后是否保留 Codex Thread

文档同时提到保存 `threadId`/恢复，又要求窗口生命周期独立。当前代码在停止时调用 `thread/delete`，这会与未来历史恢复冲突。

结论：一次性 Thread，`ephemeral = true`，关闭时删除；任何路径都不得调用 `thread/resume`。

### D. 审批按钮是否只保留“允许一次/拒绝”

Codex 0.154.0 的 schema 还支持 `acceptForSession`、`cancel`、exec-policy amendment，以及 permission 的子集授权。只做两个按钮会丢失协议能力，某些请求也不能准确表达。

结论：完整渲染可用决策，包括允许一次、会话内允许、规则授权、拒绝和取消；不缩减成二按钮。

### E. 是否把 `requestUserInput` 纳入首版

我认为必须纳入。没有 TUI 后，如果 Agent 发起澄清问题而客户端不能渲染/回答，会话会永久卡住；这不是可选美化。

结论：首版阻断能力；Mac/Web 都必须展示问题、选项、其他回答和敏感输入，并能回传答案。

### F. 是否在首版自动恢复崩溃前仍存活的 App Server

结论：不恢复旧 runtime；启动时清理所有能够由 metadata、命令行和受限 socket 命名共同证明属于 TermRelay 的遗留进程与文件，不能匹配所有权的进程绝不处理。

### G. 模式字段是否做破坏性重命名

当前全链路使用：

```text
runtimeMode = terminal | structured
webDisplayMode = approval | full
```

结论：一次性改为 `pty | acp`，删除 `webDisplayMode`。迁移明确清空不兼容的旧会话、命令、事件和审批数据，不保留 `terminal | structured` 读取路径。

## 13. 实施基线

```text
UI 名称：PTY / ACP（Codex App Server）
内部名称：pty / acp
Socket：短临时路径，runtime.json 放 Cache
Thread：首版 ephemeral，不 resume
审批：完整渲染 availableDecisions
requestUserInput：首版必须支持
Crash recovery：清理经所有权验证的 TermRelay 遗留资源，不恢复
Wire/DB：直接使用 pty/acp，删除 webDisplayMode 和旧数据
```
