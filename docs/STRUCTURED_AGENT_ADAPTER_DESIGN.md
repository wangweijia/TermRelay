# TermRelay 结构化智能体适配层设计

> 文档状态：设计基线
>
> 版本：1.0
>
> 日期：2026-09-10
>
> 关联决策：[ADR-001：Codex 结构化集成使用官方 App Server Protocol](ADR-001-CODEX-APP-SERVER.md)

## 1. 目标

本文定义 TermRelay 如何接入 Codex App Server，以及未来如何增加其他结构化智能体，而不让
Mac 会话核心、TermRelay Server 或 Web UI 依赖某个厂商的原始协议。

设计目标：

1. 保持 PTY 是所有 CLI 的通用基础能力。
2. 把 Codex、ACP 或其他厂商协议封装在独立 Adapter 内。
3. 用最小、稳定的内部模型表达跨智能体共有能力。
4. 用 capability 描述差异，不假设所有智能体都支持审批、恢复或 steering。
5. Mac 端完成厂商协议到 TermRelay Contract 的转换。
6. 新增智能体时不修改终端渲染、Server 连接和会话核心。
7. 协议失败时保持 PTY 可用，并避免重复执行用户请求。

非目标：

- 不设计一个覆盖所有现有和未来智能体功能的“万能协议”。
- 不把 Codex App Server JSON-RPC 直接暴露给 Server 或 Web。
- 不要求所有普通 CLI 都提供结构化事件。
- 不在首版同时运行 Codex PTY TUI 和 Codex App Server 模式。
- 不在当前阶段实现 Claude、Gemini 或 ACP Adapter。
- 不用结构化 Adapter 替代 TermRelay 的设备、会话、ACK 和重连协议。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| CLI Tool | 可以在终端内启动的命令，例如 Shell、Codex TUI |
| Agent Provider | 提供结构化会话协议的智能体实现，例如 Codex App Server |
| Terminal Mode | 通过 PTY 运行工具，交换终端字节、输入和尺寸 |
| Structured Mode | 通过厂商协议交换 turn、消息、工具、审批等语义事件 |
| Adapter | 隔离某个运行时或厂商协议，并转换为内部模型的组件 |
| Capability | Adapter 在当前版本和配置下实际支持的可选能力 |
| Agent Session | Mac 上一个结构化智能体会话实例 |
| Managed Session | TermRelay 管理的产品级会话，可承载 Terminal 或 Structured Mode |
| Provider Reference | 厂商生成的 thread、turn、item 等不透明标识 |
| ToolEvent | Mac 内部规范化后的智能体事件 |
| ToolAction | Mac 内部发送给智能体的规范化动作 |

## 3. 总体架构

```text
                         TermRelay Contract
Browser <-> Server <----------------------------> Mac RemoteCore
                                                      |
                                                ManagedSession
                                                 /          \
                                                /            \
                                    Terminal Runtime     Agent Runtime
                                         |                   |
                                   TerminalAdapter   StructuredAgentAdapter
                                         |              /           \
                                        PTY    CodexAppServer     Future ACP
                                         |              |
                              Shell / Codex TUI      stdio JSONL
                                                        |
                                                 codex app-server
```

关键依赖方向：

```text
SessionCore -> AgentCore protocol
CodexAdapter -> AgentCore protocol
RemoteCore -> AgentCore DTO

AgentCore -X-> Codex generated types
SessionCore -X-> Codex JSON-RPC
Server/Web -X-> Codex JSON-RPC
```

`-X->` 表示禁止依赖。

## 4. 建议目录

```text
apps/mac/Sources/
├── Session/
│   ├── ManagedSession.swift
│   ├── SessionManager.swift
│   └── SessionRuntime.swift
├── Terminal/
│   ├── TerminalSession.swift
│   └── TerminalRuntime.swift
├── Agents/
│   ├── Core/
│   │   ├── StructuredAgentAdapter.swift
│   │   ├── AgentCapabilities.swift
│   │   ├── AgentDescriptor.swift
│   │   ├── AgentSession.swift
│   │   ├── ToolAction.swift
│   │   ├── ToolEvent.swift
│   │   └── AgentError.swift
│   ├── Codex/
│   │   ├── CodexAppServerAdapter.swift
│   │   ├── CodexAppServerProcess.swift
│   │   ├── CodexAppServerClient.swift
│   │   ├── CodexEventMapper.swift
│   │   ├── CodexCapabilityMapper.swift
│   │   └── Generated/
│   ├── ACP/                       # 达到重新评估条件后再创建
│   └── Testing/
│       ├── FakeAgentAdapter.swift
│       └── ScriptedAgentAdapter.swift
├── Remote/
│   ├── ServerConnection.swift
│   ├── MessageRouter.swift
│   └── ToolEventEncoder.swift
└── Tools/
    ├── CLIToolAdapter.swift       # 普通 CLI 检测与 PTY 启动
    └── ToolRegistry.swift
```

`CLIToolAdapter` 和 `StructuredAgentAdapter` 的职责不同：

- `CLIToolAdapter`：描述可执行文件、参数、环境和 PTY 启动方式。
- `StructuredAgentAdapter`：管理结构化协议连接、会话、动作和事件。

Codex 可以同时在 Registry 中声明这两种集成能力，但一次 Managed Session 只能选择一种
runtime。

## 5. 会话 Runtime

不要让 `ManagedSession` 通过 `if provider == "codex"` 分支选择行为。使用 runtime 封装模式：

```swift
enum SessionRuntime {
    case terminal(any TerminalRuntime)
    case structured(any StructuredAgentRuntime)
}
```

产品级状态独立于厂商状态：

```swift
enum ManagedSessionState: String, Codable, Sendable {
    case created
    case starting
    case ready
    case running
    case awaitingApproval
    case interrupting
    case degraded
    case finished
    case failed
}
```

Adapter 可以拥有更细的内部状态，但向 SessionCore 只能发布上述规范化状态和诊断信息。

### 5.1 生命周期

```text
created
  -> starting
  -> ready
  -> running <-> awaitingApproval
  -> interrupting -> ready
  -> finished

starting/running/ready -> degraded -> ready|failed
any nonterminal state -> failed
```

约束：

- 同一 session 同一时间最多有一个 active turn，除非未来 capability 明确允许并发 turn。
- `startTurn` 只允许在 `ready`。
- `steer` 只允许在 `running` 且 capability 支持。
- 审批响应必须匹配 session、turn 和 approval ID。
- `stop` 必须幂等。
- 进入 `finished` 或 `failed` 后不接受新动作。

## 6. 核心接口

以下 Swift 代码是接口设计基线。实现时可以根据 Swift 并发检查调整细节，但不能破坏职责边界。

```swift
protocol StructuredAgentAdapter: Sendable {
    var providerID: AgentProviderID { get }
    var displayName: String { get }

    func detect() async throws -> AgentInstallation
    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime
}

protocol StructuredAgentRuntime: AnyObject, Sendable {
    var descriptor: AgentDescriptor { get async }
    var events: AsyncStream<ToolEvent> { get }

    func start() async throws
    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference
    func resumeSession(_ reference: AgentSessionReference) async throws
    func send(_ action: ToolAction) async throws
    func stop() async
}
```

Adapter 是无会话或轻状态工厂；Runtime 对应一个受管理的本地进程/连接，持有协议状态和事件流。
不要在全局共享一个可变 Adapter 来承载多个会话。

### 6.1 安装与描述信息

```swift
struct AgentInstallation: Sendable {
    let executableURL: URL
    let version: String
    let supported: Bool
    let unsupportedReason: String?
}

struct AgentDescriptor: Sendable {
    let providerID: AgentProviderID
    let providerVersion: String
    let protocolName: String
    let protocolVersion: String?
    let capabilities: AgentCapabilities
}
```

`detect()` 不能启动 turn 或修改工作区，只允许定位程序、读取版本和执行无副作用的能力探测。

## 7. Capability 模型

不要通过 provider 名称推断功能。Runtime 握手完成后发布实际能力：

```swift
struct AgentCapabilities: OptionSet, Codable, Sendable {
    let rawValue: UInt64

    static let streamingText       = Self(rawValue: 1 << 0)
    static let reasoning           = Self(rawValue: 1 << 1)
    static let commandExecution    = Self(rawValue: 1 << 2)
    static let commandOutput       = Self(rawValue: 1 << 3)
    static let fileChanges         = Self(rawValue: 1 << 4)
    static let approvals           = Self(rawValue: 1 << 5)
    static let plans               = Self(rawValue: 1 << 6)
    static let steering            = Self(rawValue: 1 << 7)
    static let sessionResume       = Self(rawValue: 1 << 8)
    static let sessionFork         = Self(rawValue: 1 << 9)
    static let images              = Self(rawValue: 1 << 10)
    static let subagents           = Self(rawValue: 1 << 11)
    static let usage               = Self(rawValue: 1 << 12)
}
```

Capability 来源：

1. 协议 initialize/capability negotiation 的明确结果。
2. 当前受支持版本的静态能力表。
3. 配置、安全策略或 feature flag 对能力的收缩。

最终能力取三者交集，不能因为 UI 想显示某功能而扩大能力。

### 7.1 UI 行为

| Capability | Mac/Web 行为 |
| --- | --- |
| `approvals` | 显示结构化审批；缺失时不得从终端文本猜测审批 |
| `steering` | 运行中允许追加输入，否则禁用该动作 |
| `sessionResume` | 允许展示恢复入口，否则进程丢失后结束会话 |
| `reasoning` | 显示独立、可折叠 reasoning 区域 |
| `plans` | 显示计划视图；不把普通助手文本解析为计划 |
| `subagents` | 显示父子会话；缺失时把相关工具调用作为普通事件 |
| `images` | 允许图片输入并执行大小、类型检查 |

## 8. 规范化动作

```swift
enum ToolAction: Sendable {
    case startTurn(TurnInput, idempotencyKey: UUID)
    case steer(TurnInput)
    case interrupt
    case resolveApproval(ApprovalResolution)
}
```

### 8.1 TurnInput

```swift
struct TurnInput: Sendable {
    let parts: [InputPart]
}

enum InputPart: Sendable {
    case text(String)
    case image(LocalImageReference)
    case workspaceResource(AuthorizedResourceID)
}
```

跨端不得发送任意本机绝对路径。Server 发送 `AuthorizedResourceID`，Mac 再解析到已经授权的本地
资源。

### 8.2 ApprovalResolution

```swift
struct ApprovalResolution: Sendable {
    let approvalID: String
    let turnID: String
    let decision: ApprovalDecision
}

enum ApprovalDecision: String, Codable, Sendable {
    case allowOnce
    case deny
}
```

首版只支持单次允许和拒绝。“本会话永久允许”或修改 sandbox 策略必须单独设计，不能映射成
`allowOnce`。

## 9. 规范化事件

```swift
struct ToolEvent: Sendable {
    let sessionID: UUID
    let sequence: UInt64
    let occurredAt: Date
    let correlation: AgentCorrelation
    let payload: ToolEventPayload
}

enum ToolEventPayload: Sendable {
    case sessionStarted(SessionStarted)
    case turnStarted(TurnStarted)
    case assistantTextDelta(TextDelta)
    case reasoningDelta(TextDelta)
    case commandStarted(CommandStarted)
    case commandOutput(CommandOutput)
    case commandCompleted(CommandCompleted)
    case fileChanged(FileChange)
    case approvalRequested(ApprovalRequest)
    case planUpdated(PlanUpdate)
    case usageUpdated(UsageUpdate)
    case turnCompleted(TurnCompleted)
    case warning(AgentWarning)
    case failed(AgentFailure)
}
```

### 9.1 事件规则

- `sequence` 由 Mac 针对 TermRelay session 单调递增，不复用厂商序号。
- delta 允许批处理，但必须保持同一 item 内顺序。
- `turnCompleted` 每个已开始 turn 最多产生一次。
- command、approval 等对象必须有稳定 ID，支持开始/更新/完成关联。
- 未知厂商 notification 默认忽略并记录计数，不伪装成助手文本。
- 无法安全映射的事件进入受限诊断，不把原始 JSON 上传 Server。
- 大文本、命令输出和 diff 必须设置单事件上限及分块规则。

### 9.2 厂商扩展

通用模型不能表达但 UI 确实需要的能力，使用有版本的扩展：

```swift
struct ProviderExtension: Sendable {
    let providerID: AgentProviderID
    let schemaVersion: Int
    let kind: String
    let payload: Data
}
```

扩展规则：

- 核心功能不能只存在于扩展字段。
- Server 可按 opaque data 保存或转发，但必须执行大小、TTL 和访问控制。
- Web 只有在认识 provider、kind 和 schemaVersion 时才渲染，否则安全忽略。
- 不能把完整 App Server notification 作为通用扩展直接透传。

## 10. 标识与持久化

| 标识 | 所有者 | 范围 | 是否跨端 |
| --- | --- | --- | --- |
| `device_id` | TermRelay | Mac 安装 | 是 |
| `session_id` | TermRelay | Managed Session | 是 |
| `message_id` | TermRelay | 单条协议消息 | 是 |
| `command_id` | TermRelay | 远程动作幂等 | 是 |
| `sequence` | TermRelay Mac | Session 事件顺序 | 是 |
| `thread_id` | Provider | Provider 会话 | 仅作为 opaque reference |
| `turn_id` | Provider | Provider turn | 关联字段 |
| `item_id` | Provider | Provider item | 关联字段 |
| `approval_id` | Adapter/Provider | 待审批动作 | 映射后跨端 |

Mac 本地至少保存：

```text
session_id
provider_id
provider_version
integration_mode
opaque thread reference
last acknowledged sequence
active turn/approval correlation
authorized workspace ID
recoverability status
```

Provider Reference 必须带 `provider_id` 和版本，不允许把 Codex thread ID 误交给其他 Adapter。

## 11. Codex App Server Adapter

### 11.1 进程边界

`CodexAppServerProcess` 负责：

- 使用绝对路径启动 `codex app-server --listen stdio://`。
- 管理 stdin/stdout/stderr pipe。
- 逐行读取 stdout，限制单行最大字节数。
- 对 stderr 做有界缓冲和敏感信息脱敏。
- 监控退出码、signal 和意外 EOF。
- stop 时先正常关闭，再按超时终止进程组。

它不负责理解 thread、turn 或 approval。

`CodexAppServerClient` 负责：

- JSON-RPC request ID 分配与 pending request 表。
- initialize/initialized 握手。
- request/response/notification 解码。
- Server 发起的双向请求，例如审批。
- 请求超时、取消和未知消息处理。
- 将类型化 App Server 事件交给 `CodexEventMapper`。

它不直接访问 TermRelay ServerConnection 或 SwiftUI。

### 11.2 启动流程

```text
detect codex
  -> validate version
  -> spawn app-server stdio
  -> initialize
  -> initialized
  -> read capabilities/model list if needed
  -> thread/start or thread/resume
  -> runtime ready
```

任何一步失败都必须结束子进程、清空 pending request，并返回类型化 `AgentError`。

### 11.3 最小映射

具体方法名以当前生成的 App Server Schema 为准，概念映射如下：

| Codex 概念 | Adapter 操作/事件 | TermRelay 结果 |
| --- | --- | --- |
| initialize | Runtime 启动 | `AgentDescriptor`/capabilities |
| thread start/resume | create/resume session | 保存 opaque thread reference |
| turn start | `ToolAction.startTurn` | `turnStarted` |
| turn steer | `ToolAction.steer` | 无即时成功语义，等待事件 |
| turn interrupt | `ToolAction.interrupt` | turn 完成或中断结果 |
| agent message delta | App Server notification | `assistantTextDelta` |
| reasoning delta | App Server notification | `reasoningDelta` |
| command execution | item lifecycle | command started/output/completed |
| file change | item lifecycle | `fileChanged` |
| approval request | 双向 request | `approvalRequested` + resolve |
| plan update | App Server notification | `planUpdated` |
| turn completed/failed | App Server notification | `turnCompleted`/`failed` |

映射测试必须使用真实 Schema 生成类型或版本化 fixture，不能只用手写 JSON 示例。

### 11.4 版本策略

- 启动前读取 `codex --version`。
- 维护最低、当前和明确不兼容版本表。
- 使用 `codex app-server generate-json-schema` 生成对应版本 Schema。
- `Generated/CodexAppServer` 不成为 TermRelay 跨端 Contract。
- 默认只使用非实验 API；实验字段必须单独 feature flag 和测试。
- 忽略未知可选字段和 notification；缺少必需字段时安全失败。
- 版本不支持时，在启动 turn 前提供 PTY 回退。

## 12. PTY 与结构化模式关系

PTY 和 Structured Agent 是两个平行 runtime，不互相模拟：

| 能力 | Terminal Runtime | Structured Agent Runtime |
| --- | --- | --- |
| 原始 ANSI 输出 | 是 | 否 |
| 键盘逐字节输入 | 是 | 否 |
| resize/鼠标报告 | 是 | 否 |
| 助手消息语义 | 不保证 | 是 |
| 精确工具状态 | 不保证 | capability 决定 |
| 结构化审批 | 禁止猜测 | capability 决定 |
| 通用 CLI 支持 | 是 | 否 |

模式由创建会话时确定。首版不支持运行中切换，因为切换可能丢失上下文或重复执行 prompt。

回退规则：

- App Server turn 启动前失败：允许用户创建新的 PTY 会话。
- turn 已启动后失败：标记 `degraded/failed`，禁止自动把原 prompt 发给 PTY。
- 恢复失败：展示诊断并要求用户明确选择恢复、新建或 PTY。

## 13. TermRelay Contract

结构化事件加入 `packages/contracts` 时遵循现有 envelope：

```json
{
  "type": "tool.assistant.delta",
  "protocolVersion": "1",
  "messageId": "...",
  "deviceId": "...",
  "sentAt": "...",
  "payload": {
    "sessionId": "...",
    "seq": 42,
    "turnRef": "opaque",
    "itemRef": "opaque",
    "text": "..."
  }
}
```

新增 Schema 的顺序：

1. 先定义内部 Swift 模型和 Codex 映射测试。
2. 确认该事件确实需要跨端。
3. 在 `packages/contracts` 增加语言无关 JSON Schema。
4. 生成 Swift 和 TypeScript DTO。
5. 增加兼容性、大小限制和非法 payload 测试。
6. 最后接入 Server 路由和 Web 展示。

不要先把所有 App Server 事件复制成跨端 Schema。

### 13.1 传输与背压

- 文本 delta 可以按 20～50 ms 或大小阈值聚合。
- command output 使用有界分块，不能无限进入内存或 MySQL。
- 状态、审批和完成事件不得因文本队列拥塞被静默丢弃。
- 每个 session 保持顺序；不同 session 可以并发发送。
- 断线时使用有界 Journal，超限优先保留状态和审批，裁剪可恢复的大块输出。
- ACK 使用 TermRelay `sequence`，不能依赖 provider event 顺序。

## 14. Server 职责

Server 负责：

- 验证 TermRelay envelope、设备、用户、session 和 command 权限。
- 按 `session_id` 路由 ToolAction 和 ToolEvent。
- 为动作提供 `command_id` 幂等。
- 保存会话状态、审批、审计和有限事件元数据。
- 向 Web 发布规范化事件和状态快照。

Server 不负责：

- 启动或连接 Codex App Server。
- 解析 Codex JSON-RPC、thread 或 item 类型。
- 根据文本猜测工具调用和审批。
- 接收本机任意路径或 Codex 凭据。
- 在 Mac 离线时替用户批准动作。

## 15. Web 职责

Web 根据 mode 和 capability 渲染：

```text
terminal
  -> xterm.js 终端视图

structured
  -> 对话消息
  -> reasoning（可选、折叠）
  -> 工具和命令状态
  -> diff/文件变化
  -> plan（可选）
  -> approval（可选）
```

Web 发送的是 TermRelay `ToolAction`，不能发送 App Server 方法名。未知事件应安全降级为“不支持的
事件类型”，不能执行其中包含的动作或 HTML。

## 16. 并发与隔离

- 一个 Runtime 的可变状态由一个 Swift actor 或等价串行执行器保护。
- pending JSON-RPC request 表必须按 request ID 原子更新。
- 每个 Managed Session 拥有独立事件序列和 action 队列。
- 多会话可以共享只读安装信息，但不共享 active turn、审批或 thread 状态。
- 慢速 Server 不能阻塞 App Server stdout 消费，否则子进程可能死锁。
- stdout 解析、事件映射、本地 UI 和网络发送使用有界异步队列解耦。
- stop/退出与事件回调竞争时，保证最多发布一次最终状态。

## 17. 错误模型

```swift
enum AgentError: Error, Sendable {
    case executableNotFound
    case unsupportedVersion(found: String)
    case processLaunchFailed
    case processExited(code: Int32?)
    case handshakeFailed
    case protocolViolation
    case requestTimedOut(method: String)
    case capabilityUnavailable(String)
    case invalidState
    case unauthorizedWorkspace
    case approvalExpired
    case recoveryFailed
}
```

错误对外分为：

- 用户可处理：升级 Codex、重新登录、选择 PTY、重新授权工作区。
- 可重试：临时启动失败、连接中断、可恢复 thread。
- 不可自动重试：协议不兼容、审批关联失败、turn 状态未知、工作区未授权。

日志必须带 session ID、provider、provider version、错误类别和 correlation ID，但不能包含 Token、
完整环境、未脱敏 prompt 或任意原始协议 payload。

## 18. 安全设计

1. App Server 使用本地 stdio，不监听局域网或公网。
2. `cwd` 只能由 Mac 上的授权工作区 ID 解析。
3. 认证信息留在 Mac/Codex 配置中，不进入 TermRelay Server。
4. 远程动作必须通过 Server 权限和 Mac 本地工作区权限两次检查。
5. 审批默认拒绝；超时、断线、未知类型和状态冲突均拒绝。
6. 结构化输出、diff、命令和 prompt 按敏感数据处理。
7. Provider Extension 需要类型白名单、版本和大小限制。
8. Adapter 子进程必须跟随会话或 App 生命周期回收。
9. 不使用 shell 拼接启动命令；可执行文件、参数和 cwd 分别传给 Process API。
10. Server/Web 不得要求 Mac 上传 Codex 配置文件或环境变量快照。

## 19. 测试设计

### 19.1 AgentCore 单元测试

- capability 的交集和 UI 决策。
- 状态机合法/非法转换。
- action 状态前置条件。
- session/turn/approval 关联隔离。
- sequence 单调性和事件批处理顺序。
- stop 幂等和单最终状态。

### 19.2 JSON-RPC Client 测试

- initialize/initialized 正常流程。
- response、notification 和反向 request 混排。
- 未知 notification/字段。
- 非法 JSON、超大行、截断 JSONL、意外 EOF。
- request 超时、重复 ID、迟到 response。
- stderr 高速输出不会阻塞 stdout。

### 19.3 Codex Mapper 测试

- 助手和 reasoning delta 顺序。
- command/item 的开始、更新、完成。
- 文件变化和 diff 大小限制。
- approval 请求、允许、拒绝、超时和串 session 防护。
- turn 完成、失败、中断只产生一个最终事件。
- 每个受支持 Codex 版本对应的 Schema fixture。

### 19.4 集成测试

- 在临时 Git 仓库启动真实 `codex app-server` 并完成握手。
- 使用无副作用 prompt 完成一轮 turn。
- 中断长 turn。
- 模拟子进程崩溃和重启恢复。
- TermRelay Server 断线时本地消费不阻塞，重连后 ACK/Journal 正常。
- 不支持版本在执行 prompt 前安全失败并允许创建 PTY 会话。

真实模型调用测试应显式启用，避免普通单元测试意外产生费用或修改工作区。

### 19.5 架构测试

可以通过依赖检查或代码审查约束：

- `Session`、`Remote` 不导入 `Agents/Codex/Generated`。
- Server/Web 不出现 App Server JSON-RPC method 字符串。
- `packages/contracts` 不复制完整 Codex Schema。
- 新 Provider Adapter 只能依赖 `Agents/Core` 和自己的生成类型。

## 20. 分阶段实现计划

### Phase SA-0：接口与测试骨架

- [ ] 创建 `Agents/Core`。
- [ ] 定义 Adapter、Runtime、capabilities、action、event 和 error。
- [ ] 创建 `FakeAgentAdapter`，验证 SessionCore 不依赖 Codex。
- [ ] 让 ManagedSession 能承载 terminal/structured 两种 runtime。
- [ ] 保持现有 PTY 行为和测试全部通过。

完成条件：使用 Fake Adapter 可以创建 session、发送 turn、收到事件、停止；代码中没有 Codex
分支进入 SessionCore。

### Phase SA-1：Codex 本地协议探针

- [ ] 实现 Process 和 JSON-RPC Client。
- [ ] 完成 initialize、thread start/resume、turn start/interrupt。
- [ ] 生成并固定当前 Codex Schema fixture。
- [ ] 映射文本、command、file change、approval、completion 和 error。
- [ ] 增加不兼容版本检测及 PTY 回退提示。

完成条件：没有 TermRelay Server 时，Mac 测试宿主可以完成本地结构化 turn 和审批闭环。

### Phase SA-2：TermRelay Contract

- [ ] 选择必须跨端的最小 ToolEvent/ToolAction。
- [ ] 增加 JSON Schema 和生成 DTO。
- [ ] 定义大小、分块、幂等、seq、ACK 和恢复规则。
- [ ] 增加 Swift/TypeScript schema validation 测试。

完成条件：Fake Adapter 事件可以经过 Mac encoder、Server validator 再被 Web 类型安全消费。

### Phase SA-3：Server/Web 闭环

- [ ] Server 增加结构化事件路由、审批和有限元数据持久化。
- [ ] Web 增加结构化会话、消息、工具、diff、plan 和审批组件。
- [ ] 完成 turn、steer、interrupt、approval 的远程动作。
- [ ] 实现重连状态快照和未决审批恢复。

完成条件：浏览器可发起一轮 Codex turn、观察工具/文件事件并处理审批，且不能控制错误 session。

### Phase SA-4：版本、安全与发布

- [ ] 维护 Codex 版本支持矩阵。
- [ ] 在至少两个支持版本运行 Schema 和端到端回归。
- [ ] 完成日志脱敏、输出配额、审批超时和异常恢复测试。
- [ ] 通过 feature flag 灰度启用结构化模式。
- [ ] 验证禁用结构化模式时 PTY 功能完全不受影响。

完成条件：满足 ADR-001 的最小验收标准，才允许默认启用。

## 21. 新智能体接入流程

以后接入新 Provider 时按以下顺序执行：

1. 确认存在可维护的结构化协议/SDK及其许可、认证和版本策略。
2. 列出它实际支持的 capability，不根据 Codex 功能补造语义。
3. 实现独立目录和 `StructuredAgentAdapter`/Runtime。
4. 厂商类型只存在于 Provider 目录。
5. 将可表达语义映射到现有 ToolEvent/ToolAction。
6. 确有产品价值且无法通用表达时，提出有版本的 Provider Extension。
7. 使用 Fake/fixture 完成单元测试，再执行真实进程集成测试。
8. 验证权限、审批、工作区和凭据边界。
9. 接入 ToolRegistry 和 capability 驱动 UI。
10. 验证新增 Provider 不需要修改 SessionCore、Remote transport 和既有 Adapter。

若第 10 项失败，先判断是核心模型缺少真正通用的概念，还是新 Provider 的特殊能力。只有前者
才允许扩展 AgentCore。

## 22. ACP 的未来位置

如果以后采用 ACP，它应是一个独立 Provider Adapter：

```text
StructuredAgentAdapter
├── CodexAppServerAdapter        # Codex 原生、能力完整
└── ACPAdapter                   # 连接 ACP Agent，提供通用兼容
```

不能改成：

```text
所有 Provider -> ACP -> TermRelay
```

除非新的 ADR 证明 ACP 已成为项目唯一结构化边界，并给出 Codex 原生能力迁移、兼容和回退方案。

重新评估 ACP 的条件沿用 ADR-001：至少两个真实 ACP Agent 需求、对外 ACP 即插即用需求、维护
多个 Adapter 的成本明显更高，或目标 Provider 只提供 ACP。

## 23. Definition of Done

任一 Structured Agent Adapter 标记为“已接入”前必须满足：

- [ ] detect 不产生工作区副作用。
- [ ] capability 来自实际探测和受支持版本，不是硬编码 UI 假设。
- [ ] Provider 原始类型没有泄漏到 SessionCore、Server 或 Web。
- [ ] turn、interrupt、completion 和 failure 生命周期完整。
- [ ] 审批缺失或异常时默认拒绝。
- [ ] 子进程/连接能可靠关闭，不遗留孤儿任务。
- [ ] 网络阻塞不会阻塞 Provider stdout 或本地 UI。
- [ ] 不会在恢复或回退时重复执行 prompt。
- [ ] 不支持版本提供明确诊断和安全回退。
- [ ] 单元、fixture、集成和端到端测试均记录实际 Provider 版本。
- [ ] 文档、能力表、Schema 和 `docs/MAC_PROGRESS.md` 已同步更新。

## 24. 当前下一步

当前仍先完成 ADR-001 Phase A 的通用 PTY Server/Web 闭环。准备开始结构化开发时，第一个 Issue
应是 **Phase SA-0：AgentCore 接口与 FakeAgentAdapter**，而不是直接在 `CodexAdapter` 中解析
App Server JSON。SA-0 验收通过后，再进入 Codex 本地协议探针。
