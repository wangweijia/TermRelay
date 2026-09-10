# ADR-001：Codex 结构化集成使用官方 App Server Protocol

> 状态：已接受
>
> 决策日期：2026-09-10
>
> 适用范围：TermRelay macOS App 的 Codex 结构化能力
>
> 官方参考：[Codex App Server](https://developers.openai.com/codex/app-server)
>
> 适配层详细设计：[TermRelay 结构化智能体适配层设计](STRUCTURED_AGENT_ADAPTER_DESIGN.md)

## 决策摘要

TermRelay 的 Codex 结构化集成直接使用 Codex 官方 `app-server` 协议，不把
[`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
作为 Codex 的必经层。

同时保留以下边界：

- PTY 是所有 CLI 工具的基础能力，也是 Codex 的稳定回退路径。
- App Server 是 Codex 专属的可选结构化增强，不替代通用 PTY 和 TermRelay 自有协议。
- Mac App 在本机以子进程方式启动 `codex app-server`，首选 `stdio` JSONL transport。
- Mac App 将 App Server 事件转换为 TermRelay 的语言无关事件；Server 和 Web 不直接依赖 Codex 原始协议。
- 不把 App Server 的 WebSocket 端口暴露给 TermRelay Server、局域网或公网。
- 当前不引入 ACP；达到本文定义的重新评估条件后再决定是否增加 ACP Adapter。

最终链路为：

```text
普通终端模式：
Web <-> TermRelay Server <-> Mac App <-> PTY <-> Shell / Codex TUI / 其他 CLI

Codex 结构化模式：
Web <-> TermRelay Server <-> Mac App <-> stdio JSONL <-> codex app-server
```

## 背景

阶段 0 已证明 SwiftTerm + PTY 可以在没有 Server 的情况下正常运行 Shell 和 Codex
TUI。PTY 能提供真实终端、输入、resize、Ctrl-C 和原始输出，但不能可靠识别助手消息、
工具调用、文件变更、审批和精确的 turn 状态。

Codex 官方 App Server 面向富客户端提供 thread、turn、item、流式事件、审批、认证和历史。
`codex-acp` 则是在 App Server 之上增加 ACP 转换：它启动 App Server，把 ACP 请求转换为
Codex 操作，再把 Codex 事件映射回 ACP。

TermRelay 已经使用 `packages/contracts` 作为 Mac、Server 和 Web 的跨端协议。如果选择
`codex-acp`，数据会经历两次语义转换：

```text
Codex App Server -> ACP -> TermRelay Contract
```

直接接入只需要一次：

```text
Codex App Server -> TermRelay Contract
```

## 选择理由

### 选择 App Server

- 它是 Codex 官方富客户端接口，新能力首先在这里出现。
- 可以完整获得 thread/turn 生命周期、增量消息、命令、文件变化、审批和错误。
- 少一层协议映射，减少语义损失、版本等待和故障定位成本。
- TermRelay 已有自有跨端 Contract，不需要 ACP 再承担一次跨端抽象。
- 本机只需要管理用户已有的 `codex` 可执行文件，不必额外分发 Node/npm Adapter。

### 当前不选择 codex-acp

`codex-acp` 是活跃且有价值的兼容项目，但它更适合已经实现 ACP Client，或希望用同一个
客户端连接多种 ACP Agent 的产品。它不是 Codex 的独立后端，仍然依赖 App Server，并且
需要跟随 Codex 版本更新协议类型和事件映射。

TermRelay 当前的通用性来自 PTY 和内部 `CLIToolAdapter`，而不是要求所有 CLI 都实现同一套
结构化协议。因此现在引入 ACP 会增加运行时、Swift Client、协议转换和测试成本，却不能
替代现有 TermRelay Contract。

## 架构边界

### 1. 两种会话模式

Codex 支持两个明确、互不混用的运行模式：

| 模式 | 本地进程 | UI | 远程数据 |
| --- | --- | --- | --- |
| `terminal` | `codex` 运行于 PTY | SwiftTerm/xterm.js | ANSI 字节、输入、resize、interrupt |
| `codexAppServer` | `codex app-server` 运行于 pipe | 结构化消息/工具/审批视图 | TermRelay 规范化事件和动作 |

第一版不尝试在同一个会话里同时运行 Codex TUI 和 App Server。官方 `codex --remote` 加
App Server WebSocket 的组合留作以后实验，不能阻塞 PTY 闭环或首版结构化模式。

### 2. Mac 端组件

建议新增或拆分以下组件：

```text
Tools/Codex/
├── CodexAdapter                 # 能力检测与模式选择
├── CodexTerminalLauncher        # 复用现有 PTY 启动路径
├── CodexAppServerProcess        # 子进程、stdin/stdout/stderr、退出管理
├── CodexAppServerClient         # JSON-RPC 编解码、请求关联、通知分发
├── CodexEventMapper             # App Server -> ToolEvent
└── Generated/                   # 与受支持 Codex 版本匹配的生成类型
```

不要让 `ManagedSession`、`ServerConnection` 或 SwiftUI 页面直接解析 App Server JSON。

### 3. 内部结构化事件

Mac 端先把厂商事件映射为内部 `ToolEvent`，再由 Remote 层编码为 TermRelay Contract。
最小事件集合为：

```text
tool.turn.started
tool.assistant.delta
tool.reasoning.delta
tool.command.started
tool.command.output
tool.command.completed
tool.file.changed
tool.approval.requested
tool.plan.updated
tool.turn.completed
tool.error
```

最小远程动作集合为：

```text
tool.turn.start
tool.turn.steer
tool.turn.interrupt
tool.approval.resolve
```

事件名称是设计基线；增加到 `packages/contracts` 前仍需逐项定义 Schema、大小限制、敏感字段、
幂等键和版本兼容规则。Server 不保存或透传任意 App Server JSON。

### 4. 会话标识映射

- `session_id`：TermRelay 会话主键，所有跨端消息使用它。
- `thread_id`：Codex App Server thread 标识，只由 Mac 的 Codex Adapter 管理。
- `turn_id` 和 `item_id`：作为结构化事件的关联信息，不替代 TermRelay `message_id`、
  `command_id` 或 `seq`。
- Server 可保存必要的 opaque provider reference，但不能依赖其格式或使用它绕过 Mac 直接连接
  Codex。

## App Server 通信流程

### 启动

1. 使用与 PTY Adapter 相同的可执行文件发现逻辑定位 `codex`。
2. 读取 `codex --version`，与支持矩阵比较。
3. 使用已授权工作区作为 `cwd`，通过 pipe 启动：

   ```bash
   codex app-server --listen stdio://
   ```

4. `stdout` 仅作为逐行 JSONL 协议流解析；`stderr` 进入有界、脱敏的诊断日志。
5. 发送 `initialize` 请求，收到成功响应后发送 `initialized` notification。
6. 未完成握手前禁止创建 thread 或 turn。

### 新会话

1. 调用 `thread/start`，明确传入已授权 `cwd` 和支持的模型配置。
2. 记录 `session_id <-> thread_id` 映射。
3. 调用 `turn/start` 发送用户输入。
4. 持续消费 item、工具、审批和 turn notification，并映射为 `ToolEvent`。
5. 收到 turn 完成或失败事件后更新 TermRelay 会话状态。

### 恢复会话

1. Mac 重连 Server 后先恢复 TermRelay 的 ACK、Journal 和状态快照。
2. Codex App Server 进程仍存活时，继续使用现有连接和 thread。
3. 进程重启后，通过 `thread/read` 或 `thread/resume` 验证 thread 是否可恢复。
4. 恢复失败时将会话标为 `degraded`，由用户明确选择新 thread 或 PTY 模式。
5. 不得自动重放未确认的用户 prompt，避免同一任务重复执行命令或修改文件。

### 审批

1. App Server 发出审批请求后，Mac 创建带关联 ID 和过期时间的 TermRelay 审批事件。
2. 本地 UI 和已授权 Web 用户都可以显示请求，但最终响应由 Mac Adapter 写回 App Server。
3. 断线、超时、未知审批类型或会话状态不一致时默认拒绝，不自动批准。
4. 审批内容和结果进入审计；命令输出和环境变量按脱敏规则处理。

## 版本与兼容策略

App Server 仍在快速迭代，必须把协议版本兼容作为功能的一部分：

1. 记录并展示实际 `codex --version`。
2. 维护“最低验证版本 / 当前验证版本 / 不兼容版本”支持矩阵。
3. 对每个正式支持的 Codex 版本执行：

   ```bash
   codex app-server generate-json-schema --out <temporary-output>
   ```

4. 生成物只描述 Codex 本地协议，不放入 `packages/contracts` 作为跨端事实源。
5. 默认不设置 `experimentalApi: true`；只有具体功能有测试和回退方案时才能启用。
6. JSON-RPC Client 必须忽略未知 notification 和未知可选字段；缺少必需字段时产生可诊断错误。
7. 依赖具体 App Server 版本的测试 fixture 必须标注 Codex 版本。
8. 正式构建固定已验证版本范围；发现不兼容时禁用结构化模式并提示升级或回退 PTY。

回退只允许发生在创建 thread/turn 之前。turn 已经开始后，不能静默在 PTY 中重新发送同一个
prompt。

## 安全约束

- App Server 只绑定本地 stdio，不监听公网或局域网端口。
- Server 和 Web 永远不能直接获得 App Server transport 的访问能力。
- `cwd` 必须来自 Mac 已授权工作区，不能直接接受 Server 发送的真实路径。
- 使用现有 Codex 登录状态或本机安全配置；Token、API Key 和完整环境不能上传 Server。
- stderr、命令输出、diff 和 prompt 都可能包含秘密，必须执行大小限制、TTL 和日志脱敏。
- App Server 子进程跟随 ManagedSession/App 生命周期清理，不能留下失去控制的后台进程。
- 结构化模式的 sandbox 和 approval policy 必须显式设置或读取后展示，不能依赖未知默认值。

## 失败与回退原则

出现以下情况时，在启动 turn 前回退到 PTY：

- 找不到 `app-server` 子命令。
- Codex 版本不在支持矩阵内。
- 子进程启动、initialize 或 capability negotiation 失败。
- 必需的 thread/turn/approval 能力缺失。
- JSON Schema 与内置 Client 不兼容。

PTY 回退必须：

- 向用户明确展示当前是普通终端模式，不提供结构化审批保证。
- 保持本地终端可用，不因 Server 或 App Server 失败而阻塞。
- 记录失败类别和 Codex 版本，但不记录凭据或完整敏感 payload。

## 开发顺序

App Server 集成不阻塞当前最小 PTY 纵向闭环，按以下顺序实施。

### A. 先完成通用 PTY 闭环

- [ ] 统一 `ManagedSession` 与 `LocalTerminalSession`。
- [ ] 完成 Mac `/ws/client` 注册、心跳、重连和状态快照。
- [ ] 完成 PTY 输出、输入、resize、interrupt 的 Server/Web 闭环。
- [ ] 完成 `seq`、ACK、有界 Journal 和断线补传。
- [ ] 通过单会话长输出、断网和重复命令测试。

### B. 实现本地 App Server 探针

- [ ] 增加 `CodexAppServerProcess`，仅使用 stdio。
- [ ] 实现 initialize/initialized 握手和 JSON-RPC 请求关联。
- [ ] 实现 thread start/read/resume 和 turn start/interrupt。
- [ ] 捕获助手 delta、命令、文件变化、审批、完成和错误事件。
- [ ] 验证进程退出、取消、超时和不完整 JSONL。
- [ ] 保存受测 Codex 版本和 Schema fixture。

### C. 建立稳定的内部边界

- [ ] 按适配层详细设计定义 `StructuredAgentAdapter` 与 `ToolEvent`，保持 Session 层与 Codex 解耦。
- [ ] 将最小 `tool.*` 事件和动作加入 `packages/contracts`。
- [ ] 生成 Swift/TypeScript DTO，并增加兼容性检查。
- [ ] 实现 `session_id`、`thread_id`、`turn_id`、审批 ID 的关联与恢复。
- [ ] 增加事件大小、背压、幂等和敏感字段规则。

### D. 接入 Server 与 UI

- [ ] Server 路由并持久化结构化事件元数据，不保存无界原始 payload。
- [ ] Web 增加结构化消息、工具执行、diff、计划和审批视图。
- [ ] Mac UI 明确区分“终端模式”和“Codex 结构化模式”。
- [ ] 完成远程 turn、steer、interrupt 和 approval 闭环。
- [ ] 保证结构化功能关闭时 PTY 功能完全不受影响。

### E. 加固和发布

- [ ] 建立 Codex 版本支持矩阵和升级回归任务。
- [ ] 覆盖崩溃恢复、断网、重复 prompt、防误批准和子进程清理。
- [ ] 对 prompt、命令、diff、输出和日志执行脱敏、TTL 和配额测试。
- [ ] 默认关闭实验能力；按功能逐项开放并保留 feature flag。
- [ ] 在至少两个受支持 Codex 版本上通过端到端测试后再默认启用结构化模式。

## 最小验收标准

App Server Adapter 达到可用状态必须同时满足：

1. 不依赖 Server 即可在 Mac 本地完成 initialize、thread 和一轮 turn。
2. 文本增量、命令、文件变化、审批、完成和错误均能转换成稳定 `ToolEvent`。
3. 用户可以中断 turn，审批能正确允许或拒绝且不会串到其他 session。
4. App Server 崩溃不会导致 Mac App 崩溃或阻塞 PTY 会话。
5. 断线或恢复流程不会自动重复发送 prompt。
6. 不受支持版本会在执行前失败并提供 PTY 回退。
7. Server/Web 不包含 Codex 原始 JSON-RPC 解析逻辑。
8. 关闭结构化 feature flag 后，现有 Shell 和 Codex PTY 行为不变。

## 何时重新评估 ACP

满足以下任一条件时，可以新建 ADR 重新评估 ACP，但不能直接替换本决策：

- TermRelay 已经需要结构化接入两个以上原生 ACP Agent。
- 对外提供“任意 ACP Agent 即插即用”成为明确产品需求。
- 维护多个厂商 Adapter 的成本已高于维护一个 ACP Client。
- ACP 的 Swift SDK、会话恢复、审批和扩展能力达到项目生产要求。
- 某个目标 Agent 只提供 ACP，而没有质量相当的官方结构化接口。

即使以后引入 ACP，也应把它实现为新的 `StructuredAgentAdapter`，而不是替换 PTY、
TermRelay Contract 或现有 Codex App Server Adapter。

## 后续维护规则

每次升级 Codex、修改结构化事件或改变回退行为时，必须同步更新：

- 本文的版本兼容策略或开发清单。
- `docs/MAC_PROGRESS.md` 中对应任务状态和实测版本。
- App Server Schema fixture 及协议测试。
- `packages/contracts` 中已公开给 Server/Web 的规范化事件。

如实现与本文决策冲突，应先新增 ADR 说明替代原因、迁移方式和回退方案。
