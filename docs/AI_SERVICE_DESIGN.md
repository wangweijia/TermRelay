# TermRelay 对外提供 AI 能力的设计方案

> 状态：已实现统一对话模型。部署与升级见 [AI_SERVICE_SETUP.md](AI_SERVICE_SETUP.md)，invest 接入待办见 [INVEST_AI_SERVICE_TODO.md](INVEST_AI_SERVICE_TODO.md)。
>
> 目标：让局域网项目调用 Mac 上的 Codex、DSH。只提供一种 conversation；业务时长、上下文复用与主动关闭由调用方控制，不区分长期／一次性模式。

## 1. 职责与通信边界

- Server 管理通用 API Key、对话与轮次记录、结果、幂等和设备路由。
- Mac 拥有模型凭据、本地路径、Agent 进程、工具权限与进程清理。
- 调用方负责业务编排、事实构造、时长、预算、输出校验和业务数据库写入。

```text
调用方 ──受信 LAN HTTP + API Key──> Server
Mac ──主动连接 /ws/client──> Server ──同一 WebSocket 下发命令──> Mac Agent
Web ──查询、查看、用户问答与停止──> Server
```

Web 不直接连接 Mac；Server 不解析 Codex／DSH 原始协议，也不保存本机真实工作目录。后台对话不需要新的 Mac 窗口。PTY 与 ACP 仍然分离，API 结构化启动失败不会降级到 PTY。

## 2. 统一对话

调用方创建 conversation，等待 `ready`，串行提交 turn，并在业务结束后关闭。每个对话最多同时执行一轮，不隐式排队。多轮共享同一 Provider 上下文，独立任务需要隔离时由调用方创建不同对话，而不是选择另一种生命周期模式。

一个对话固定创建时的设备、Provider、模型、推理强度和本机目录授权。后续 turn 不修改这些设置。每轮仍应提交最新事实、时间和快照标识，明确哪些旧信息已被替代；上下文容量受 Provider 限制，不承诺无限记忆。

| 对话状态 | 含义 |
| --- | --- |
| `starting` | 正在启动 Provider |
| `ready` | 可继续使用；`activeTurnId` 非空表示当前轮尚未结束 |
| `closing` | 拒绝新轮次，等待已有轮次结束和 Mac 停止确认 |
| `closed` | 不可继续使用，运行时已结束或异常终止 |

turn 状态为 `accepted`、`running`、`succeeded`、`failed`、`cancelled`。`waitingFor = input | approval | null` 单独描述交互等待；等待也是未完成任务。`succeeded` 只表示执行完成且输出通过声明的通用格式校验，不表示业务结论正确。

## 3. 时长与优雅关闭

创建对话时可选 `timeoutSeconds`，取值为 1 至 2147483647 的整数秒，从 Server 接受创建时起算。Server 保存绝对 `expiresAt`；省略时为 `null`，没有自动过期时间。幂等重试返回原对话，不重置计时。

到期的处理规则：

1. 对话进入 `closing`，新 turn 返回 `409 conversation_closing`。轮次准入与过期判断在同一持久化事务中进行，不依赖定时器恰好先执行。
2. 空闲或还在启动、没有活动轮次的对话立即请求停止运行时。
3. 已接受／执行中／等待用户回答的轮次继续完成，不因对话到期被取消。
4. 活动轮次成功、失败或确认取消后持久化其结果，再下发关闭命令。
5. Mac 停止所属运行时、清理临时目录并返回 `closed`，Server 才正常释放容量。

因此 `timeoutSeconds` 是不再接收新工作的时间，不是硬性进程终止时间；正在等待用户回答的轮次可能使关闭延后。主动 `DELETE` 使用同样的优雅关闭规则。若业务需要立即停止，调用方先取消活动 turn，再关闭对话；Mac／Web 的停止操作仍可直接结束所属运行时。

单轮不再有默认 180 秒限制，也不再接受 `deadlineSeconds`。启动仍有 30 秒保护；取消确认及空闲运行时关闭确认仍有有界保护。这些保护只针对异常启动／停止，不决定业务对话的正常持续时间。关闭确认超时标记 `close_timeout` 和结果未知；Mac 本地正在停止的运行时仍计入容量，避免在进程清理期间超额启动。

## 4. API 与输入输出

所有端点位于 `/api/ai/v1`，携带 `Authorization: Bearer <API_KEY>`。创建及 turn 提交必须带 `Idempotency-Key`。

| 端点 | 用途 |
| --- | --- |
| `GET /targets` | 查询在线设备、Provider、容量和工作目录授权 |
| `POST /conversations` | 创建对话，不隐式执行首轮 |
| `GET /conversations/{id}` | 查询状态、活动轮次、过期时间、关闭原因与错误 |
| `POST /conversations/{id}/turns` | 在可用对话中提交新一轮 |
| `GET /conversations/{id}/turns/{turnId}` | 查询轮次状态、结果和错误 |
| `POST /conversations/{id}/turns/{turnId}/cancel` | 请求取消该轮，查询确认终态 |
| `DELETE /conversations/{id}` | 幂等请求优雅关闭 |

创建正文：

```json
{
  "target": { "deviceId": "<mac-device-uuid>" },
  "provider": "codex",
  "displayName": "调用方的分析对话",
  "timeoutSeconds": 3600
}
```

只有 target 和 provider 必填；model、effort、displayName 和 timeoutSeconds 可选。deviceId 使用固定 Mac 设备 ID，Server 不自动选设备或故障转移。Mac 连接后及配置变化时公布可用 Provider，但能力公布不保证凭据或模型请求必然成功。模型与强度由 Provider 验证；DSH 当前不支持任意模型／强度设置。

轮次正文：

```json
{
  "input": {
    "instructions": "根据本轮最新事实返回分析结果。",
    "facts": { "snapshotId": "snapshot-001" }
  },
  "output": {
    "kind": "json",
    "schema": { "type": "object" }
  }
}
```

input 的 instructions、facts 至少一项非空。Mac 将指令与事实映射到 Provider，不承诺等价于原生 system role，调用方指令不能覆盖本机权限。output 每轮显式声明 text 或 json，JSON 支持受限内联 Schema；拒绝远程 `$ref`、正则表达式、format 及过度复杂的结构。

Mac 只收集当前 turn 的最终回答，不把思考、工具输出或中间消息拼入结果。JSON 接受纯 JSON 或只包含完整 JSON 的单个 Markdown 代码块；解析失败为 `invalid_json`，Schema 不符为 `schema_mismatch`，保留有界 rawText。模型修复由调用方明确提交新 turn，TermRelay 不隐式再请求模型。

结果包括 conversationId／turnId、status、waitingFor、cancelRequested、result、error、实际模型／强度、usage 和耗时。未知模型或精确用量为 `null`，不猜测。内部启动／停止确认截止时间不作为业务时长返回。

## 5. 原子性、容量与幂等

Server 用数据库事务和 `ai_service_mutex` 序列化准入、幂等与终态裁决。每台 Mac 最多四个外部对话，同时限制 Provider 容量；空闲和 `closing` 对话仍占容量。Mac 在启动前再次检查本地容量，正在启动与停止的进程同样计入。

同操作范围、同幂等键、同规范化请求返回原资源；内容不同返回 `409 idempotency_conflict`。turn 的范围包含父 conversation ID。所有新通用 Key 共用服务范围，调用方使用 UUID 等唯一幂等键；旧版受限 Key 只兼容查询原有资源，不能继续执行。重试已接受的轮次即使对话正在关闭，也返回原轮次，不创建新任务。

Mac 按稳定对话／轮次 ID 去重。Server 先持久化状态和结果，再发送取消、关闭和结果确认，不让事务回滚留下已执行的控制命令。正常终态不能被迟到的运行状态或结果覆盖；迟到的 `ready` 也不能重新打开 `closing` 对话。

取消是请求而不是已停止证明：返回 `202` 后查询轮次终态。成功结果先提交时保留成功；取消确认失败则结束所属运行时并明确返回 `cancel_timeout`，不无限等待停止确认。

## 6. 断线、异常与数据保留

HTTP 请求断开不结束对话。Mac 连接断开、Agent 退出或 Server 重启会结束相关外部对话；错误区分 `connection_lost`、`runtime_exited`、`server_restarted`。可能已执行但结果无法确认时使用 `executionOutcome = unknown`，不意味着工具操作没有发生。

不实现旧进程／上下文恢复、自动重跑或断线排队。Mac 断线时只停止自己拥有的外部运行时；重新连接只接受新对话。活动外部对话即使尚未提交首轮，也不能被“无用户消息 ACP 清理”误删。

状态、结果和幂等记录在结束后保留 30 天；原始输入、受限原始回答和详细外部事件保留 24 小时。保留 TTL 不关闭活动对话。调用方保存长期需要的结果。外部事件不写 Mac 的持久化 RelayOutbox，未确认结果只保留在当前连接生命周期内，临时目录按所有权清理。

## 7. Mac、Web 与执行权限

`AIRuntimeManager` 使用 actor 和 Sendable 边界，复用结构化 Adapter／Coordinator。UI 状态留在 `@MainActor`。Server 下发 `ai.session.create`、`ai.turn.start`、`ai.turn.cancel`、`ai.session.close`；Mac 返回规范化事件和结果。JSON Schema 是跨端协议源，生成文件不手工修改。

Mac 与 Web 的项目调用栏目统一标记为对话；每轮结束显示等待下一轮，直到主动／超时关闭才清理运行时。外部会话的 origin、projectId 和 aiResourceId 保留，projectId 为内部兼容来源，不代表业务配置；移除 oneShot／longLived 分类。UI 不能随意插入外部 turn，避免改变调用方上下文。

Mac 设置开启 AI 服务、选择工具与可选 Codex 工作目录。真实路径与模型凭据留在 Mac；调用方不能指定任意本机路径。无授权目录时使用隔离临时目录和 OS 沙箱，禁止子进程与普通文件写入，但不承诺文件读取或网络的完整隔离。Codex 使用独立 CODEX_HOME，只复制登录凭据；DSH 暂不提供工作目录工具。

项目 API 审批由 Mac 自动处理，优先允许一次；失败明确结束任务，不继续等待。自动审批不能扩大沙箱／本机授权范围。用户问题不自动填写，必须由用户回答或调用方明确取消。工作目录变更只影响新对话。

## 8. Key 与部署边界

通用 API Key 不绑定项目、设备或用途；所有持有人共享 AI 资源访问与控制权限，只发给可信调用方。Key 具有至少 256 位随机性，只在生成时显示完整明文，数据库保存 SHA-256 哈希。Key 不放在前端、URL、日志或 Git；撤销不自动取消正在运行的任务。

AI 调用 API 只允许受信 LAN／Docker 网络，拒绝公网、转发和 Cloudflare 标识的请求；Tunnel 必须阻断 `/api/ai/v1/*`。HTTP 不加密传输。浏览器 `/settings` 与 Key 管理沿用现有 Web 的 Cloudflare Access 入口保护，同源写入，不增加另一套账户体系。设备凭据、本机权限与 Key 调用鉴权各自保持边界。

升级必须一起更新 Mac、Server、Web 并执行 `UnifiedAIConversations1791820800000` migration。旧 `/jobs` API 删除；原 job 改为创建对话、执行一轮、查询结果并关闭。旧 job 历史规范化为已关闭 conversation，结果保留，未结束任务标记升级期间结果未知；旧运行时不恢复。迁移回滚不会恢复旧资源分类，升级前应备份并停止旧版本。

## 9. 验收

- 无效／撤销 Key 不可调用；生成 Key 不要求 Mac 在线，旧受限 Key 不自动扩权。
- 同请求并发重试只创建一个对话／轮次，Key 轮换不改变幂等结果。
- 不传超时可以持续复用对话，轮次没有隐式 180 秒限制；串行准入、容量和输出限制仍有效。
- 到期前接受的轮次完成后保留结果，到期后新轮次拒绝；空闲对话到期关闭，重复关闭不重复停止。
- 关闭确认前不释放容量，迟到 ready 不重开对话，控制命令只在持久化成功后下发。
- 取消、断线、启动失败和重启的异常行为明确；不恢复旧上下文、不自动重跑。
- 手动 PTY／ACP、项目自动审批、本机沙箱、来源分组和历史保留行为不受影响。
