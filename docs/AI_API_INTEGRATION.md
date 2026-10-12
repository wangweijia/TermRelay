# TermRelay 第三方 AI 接入手册

> 面向使用方开发者与编码 AI。最后核对：2026-10-13。
>
> 本文对应当前源码的**统一对话版本**，不是对线上部署版本的声明。部署前必须同步更新 Server、Mac、Web，并执行 `UnifiedAIConversations1791820800000` 数据库迁移。旧 `/jobs` API 不适用于本文。
>
> 只需把本文交给使用方 AI，再提供 Server 局域网地址、API Key、设备 ID 和所选 Provider，即可实现接入。不要把真实 API Key 写入本文、提示词示例、前端或 Git。

## 1. 给使用方 AI 的执行规则

实现顺序固定为：

```text
读取后端配置
  → GET /targets，检查指定设备及 Provider
  → POST /conversations，保存 conversationId
  → 轮询对话，等待 ready
  → POST /conversations/{conversationId}/turns，保存 turnId
  → 轮询该轮，等待 succeeded / failed / cancelled
  → 保存并校验 result
  → 按业务需要继续下一轮，或 DELETE 对话并确认 closed
```

必须遵守：

1. 对话统一为 conversation，任务统一为 turn。不实现 job、长／短模式、OpenAI `chat/completions`、消息角色数组或流式接口。
2. 创建对话**不执行首轮**，也不携带 input、output。任务放在单独的 turn 请求中。
3. 每个对话串行执行；`ready` 不等于空闲，还要检查 `activeTurnId === null`。
4. 创建对话和提交轮次分别使用独立的 UUID 幂等键。网络重试复用原键及原正文，不创建新业务请求。
5. 保存 conversationId、turnId、请求正文和幂等键。进程重启后先查询已保存的资源，不自动重跑。
6. 正常时长由使用方控制。`timeoutSeconds` 只在创建时可选；到期拒绝新轮次，但等待已有轮次结束才关闭。
7. 单轮没有默认 180 秒限制。不要发送 `deadlineSeconds`，也不要把本地 HTTP／轮询超时当作远端任务已取消。
8. `202` 只代表请求已接受；创建、执行、取消和关闭都要查询状态确认。
9. `failed`、`cancelled`、`error.executionOutcome = unknown` 都不能当作成功，未知结果也不能当作“没有执行”。
10. 使用方自行控制独立任务的上下文隔离、业务校验、重试预算和关闭时机。关闭对话不会删除已经保存的结果。

## 2. 配置与准备

### 2.1 使用方后端配置

以下是建议的使用方环境变量名；**不是新增的 Server 环境变量**：

| 配置 | 必填 | 示例／默认 | 含义 |
| --- | --- | --- | --- |
| `TERMRELAY_BASE_URL` | 是 | `http://<SERVER_LAN_IP>:3006` | Server 根地址，不包含 `/api/ai/v1` |
| `TERMRELAY_API_KEY` | 是 | `<从 Web 配置页复制的完整 Key>` | 调用凭据，完整 Key 以 `trai_` 开头 |
| `TERMRELAY_DEVICE_ID` | 是 | `<Mac 设备 UUID>` | 固定目标 Mac，不是会话 ID，也不是工作目录 |
| `TERMRELAY_PROVIDER` | 否 | `codex` | `codex` 或 `dsh`；必须由目标设备公布 |
| `TERMRELAY_MODEL` | 否 | 省略 | Provider 实际支持的模型 ID |
| `TERMRELAY_EFFORT` | 否 | 省略 | Provider 实际支持的推理强度 ID |
| `TERMRELAY_TIMEOUT_SECONDS` | 否 | 省略 | 创建对话的可选有效时长；不是单轮硬截止时间 |
| 使用方 HTTP 超时 | 建议 | 10 秒 | 单次 HTTP 通信预算，不改变远端生命周期 |
| 使用方轮询间隔 | 建议 | 1 秒 | 查询状态的间隔，避免无间隔轮询 |
| 使用方业务等待预算 | 自行决定 | 按业务配置 | 等待超过预算后应查询、取消或人工处理，不能静默重提 |

示例占位配置：

```dotenv
TERMRELAY_BASE_URL=http://<SERVER_LAN_IP>:3006
TERMRELAY_API_KEY=<FULL_API_KEY>
TERMRELAY_DEVICE_ID=<MAC_DEVICE_UUID>
TERMRELAY_PROVIDER=codex
# 不确定 Provider 的模型／强度 ID 时，省略这两项：
# TERMRELAY_MODEL=<PROVIDER_MODEL_ID>
# TERMRELAY_EFFORT=<PROVIDER_EFFORT_ID>
# 可省略；省略后由使用方主动关闭：
# TERMRELAY_TIMEOUT_SECONDS=3600
```

不要把占位符原样发送给 Server。密钥使用后端的密钥管理或忽略提交的环境文件，不下发到浏览器。

### 2.2 Server 与网络要求

- Server 必须启用数据库并完成迁移；关闭数据库会返回 `503 ai_requires_database`。
- 本地开发默认地址为 `http://127.0.0.1:3007`，生产发布默认宿主机端口为 `3006`；实际端口以部署配置为准。
- Docker 调用方中的 `127.0.0.1` 指向调用方容器自身，不能用它连接另一容器／宿主机。使用可达的 LAN 地址或共享 Docker 网络服务名。
- AI 调用只能通过受信 LAN／Docker 网络访问 Server。允许 loopback、IPv4 私网和 IPv6 本地／链路本地来源，不允许公网来源。
- 请求带 `X-Forwarded-For`、`CF-Ray` 或 `CF-Access-Jwt-Assertion` 会被拒绝。因此不要通过 Cloudflare Tunnel／Access 域名或会注入这些头的代理调用 AI API。
- 使用方若配置了全局 HTTP 代理，应把 Server 地址加入 `NO_PROXY`／`no_proxy` 或为此客户端禁用代理。Mac 上 CLI 的模型网络代理是另一项配置，不应套用到调用方访问 LAN Server 的请求。
- Web 可以通过已有 Access 入口管理 Key，但这不代表 `/api/ai/v1/*` 允许同一公网入口访问。
- HTTP 部署不提供传输加密，只用于受信网络。调用方只与 Server 通信，不直接连接 Mac。
- `/health` 正常不代表 Mac 在线、Provider 可用或模型认证有效；必须做 `/targets` 检查和真实业务验收。

Server 的数据库连接使用 `DB_ENABLED`、`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`。使用方不需要、也不应取得这些数据库凭据。具体部署见 [环境说明](ENVIRONMENTS.md) 和 [Server 发布说明](SERVER_RELEASE.md)。

### 2.3 Mac 配置

由设备所有者在 Mac App 完成，不由调用方通过 API 修改：

1. 在“连接与交互”连接 `ws://<SERVER_LAN_IP>:<PORT>/ws/client`。第三方 AI 能力使用这条 LAN 连接，不使用 `/ws/client-public`。
2. 在“工具与凭据”配置 Codex／DSH 可执行文件及登录凭据；DSH 的 DeepSeek Key 保存在 macOS 钥匙串。
3. 在“AI 服务”开启服务，默认关闭。服务开启后公布可用 Provider。
4. 如需 Codex 访问项目工具，使用本机文件夹选择器授权工作目录；真实路径只留在 Mac。

| Provider | 第三方 API 支持 | 模型／强度参数 | 工作目录工具 |
| --- | --- | --- | --- |
| `codex` | 支持 | 可选，启动时由 Codex 验证 | 仅在 Mac 授权目录后开放 |
| `dsh` | 支持 | 当前建议省略；Adapter 不支持任意模型／强度切换 | 不开放工作目录工具 |
| `copilot`／Shell／PTY | 不支持本 API | 不适用 | 不适用 |

Mac／Web 支持某个手动智能体，不等于第三方 API 也支持它。没有模型列表 API；不要发明 `/models` 端点，也不要套用其他服务的模型 ID。

未授权目录时使用隔离临时目录与 OS 沙箱，禁止子进程及普通文件写入；这不是完整的文件读取／网络隔离。授权 Codex 目录后可使用工具，审批由 Mac 自动处理，优先允许一次。调用方不能通过提示词或请求路径扩大本机权限。

### 2.4 获取 Key 与设备 ID

打开 TermRelay Web 的 `/settings`：

- “API Key” → 生成 → 复制完整 Key → 存入调用方后端。完整值只显示一次，Key 列表中的管理标识**不能**用来鉴权。
- “可用 AI 设备” → 复制设备 ID → 查看 Provider 和目录授权。
- Key 不绑定项目、设备或用途；所有通用 Key 持有人共享 AI 资源的查询和控制权限，只发给可信调用方。
- Key 替换时先更新调用方，再撤销旧 Key。撤销后拒绝新的 API 请求，不自动停止已有任务；关闭／查询应使用仍有效的 Key。
- 旧受限 Key 不会自动扩权，需在 Web 生成通用替换 Key。

## 3. HTTP 约定

API 前缀：

```text
{TERMRELAY_BASE_URL}/api/ai/v1
```

| Header | 使用场景 | 值 |
| --- | --- | --- |
| `Authorization` | 所有 AI API 请求 | `Bearer <完整 API Key>` |
| `Content-Type` | 有 JSON 正文的 POST | `application/json` |
| `Idempotency-Key` | 创建对话、提交轮次 | 8～64 位，仅 `A-Z a-z 0-9 _ -`；推荐 UUID |

取消 POST 与关闭 DELETE 没有业务正文，不要求 `Idempotency-Key`，可按固定资源 ID 重复请求。GET 也不需要幂等键。

请求对象拒绝未声明的字段。可选参数省略即可，**不要用 `null` 代替省略**。对话／轮次 ID 是 Server 返回的 UUID，不由调用方生成；只有幂等键由调用方生成。

## 4. 全部接口

| 方法 | 相对 `/api/ai/v1` 的路径 | 成功 HTTP 状态 | 用途 |
| --- | --- | --- | --- |
| GET | `/targets` | 200 | 查询当前设备及能力 |
| POST | `/conversations` | 202 | 创建对话，返回对话资源 |
| GET | `/conversations/{conversationId}` | 200 | 查询对话资源 |
| POST | `/conversations/{conversationId}/turns` | 202 | 提交一轮，返回轮次资源 |
| GET | `/conversations/{conversationId}/turns/{turnId}` | 200 | 查询轮次资源与结果 |
| POST | `/conversations/{conversationId}/turns/{turnId}/cancel` | 202 | 请求取消该轮，返回轮次资源 |
| DELETE | `/conversations/{conversationId}` | 202 | 请求优雅关闭，返回对话资源 |

当前没有对话列表、轮次列表、批量任务、业务队列、SSE、流式结果、上下文恢复、修改对话参数或机器调用用户问答接口。使用方必须保存资源 ID。

### 4.1 查询目标设备

```bash
curl --fail-with-body \
  "$TERMRELAY_BASE_URL/api/ai/v1/targets" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY"
```

响应是**数组**，不是 `{ "targets": [...] }`：

```json
[
  {
    "deviceId": "12345678-1234-4234-8234-123456789abc",
    "name": "Studio Mac",
    "online": true,
    "providers": [
      {
        "provider": "codex",
        "capacity": 4,
        "workspaceEnabled": true
      }
    ]
  }
]
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `deviceId` | string | 创建时使用的固定设备 UUID |
| `name` | string | 展示名称，不用于路由 |
| `online` | boolean | 当前是否有设备连接 |
| `providers` | array | 当前连接公布的 Provider |
| `providers[].provider` | `codex`／`dsh` | 可请求的 Provider ID |
| `providers[].capacity` | integer，1～4 | Provider 容量上限，不是剩余槽位数 |
| `providers[].workspaceEnabled` | boolean | 是否授权本机工作目录工具，不包含真实路径 |

只选择 `online === true` 且 providers 包含所需 Provider 的设备。在线设备也可能 `providers: []`；旧受限 Key 的查询可能返回空数组。能力与空闲容量仍以创建时检查为准。

同一 Mac 上 Codex 与 DSH 共用**最多四个外部对话**，不能把两个 Provider 的 `capacity: 4` 理解为共可启动八个。空闲对话也占容量，应及时关闭。

### 4.2 创建对话

```http
POST /api/ai/v1/conversations
Authorization: Bearer <API_KEY>
Idempotency-Key: <CREATE_REQUEST_UUID>
Content-Type: application/json
```

```json
{
  "target": {
    "deviceId": "12345678-1234-4234-8234-123456789abc"
  },
  "provider": "codex",
  "displayName": "行情分析",
  "timeoutSeconds": 3600
}
```

| 参数 | 类型 | 必填 | 范围／默认与说明 |
| --- | --- | --- | --- |
| `target` | object | 是 | 只能包含 deviceId |
| `target.deviceId` | string | 是 | UUID，实际校验 UUID 版本 1～8 与标准 variant；不要填本机路径 |
| `provider` | string | 是 | 只能为 `codex` 或 `dsh` |
| `model` | string | 否 | 1～128 字符；省略使用 Provider 默认模型；有效性由 Provider 验证 |
| `effort` | string | 否 | 1～32 字符；省略使用 Provider 默认值；不是固定通用枚举 |
| `displayName` | string | 否 | 1～128 字符；省略使用 Provider ID |
| `timeoutSeconds` | integer | 否 | 1～2147483647 秒；省略没有自动过期时间 |

deviceId、Provider、模型、强度、工作目录授权在创建后固定。想改模型或设备，应创建新对话，不给 turn 填这些字段。

最小合法正文：

```json
{
  "target": { "deviceId": "12345678-1234-4234-8234-123456789abc" },
  "provider": "codex"
}
```

示例创建命令：

```bash
# CREATE_KEY 在同一创建请求的全部重试中保持不变。
CREATE_KEY="$(uuidgen)"
curl --fail-with-body -X POST \
  "$TERMRELAY_BASE_URL/api/ai/v1/conversations" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CREATE_KEY" \
  --data "{\"target\":{\"deviceId\":\"$TERMRELAY_DEVICE_ID\"},\"provider\":\"codex\",\"timeoutSeconds\":3600}"
```

典型响应见第 5 节。保存 `conversationId` 后查询对话；只在 `ready` 且 `activeTurnId: null` 时提交第一轮。幂等重试仍返回 202，但资源可能已经 ready、closing 或 closed；不要假设每次响应都 starting。

### 4.3 查询对话

```bash
curl --fail-with-body \
  "$TERMRELAY_BASE_URL/api/ai/v1/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY"
```

| `status` | 使用方处理 |
| --- | --- |
| `starting` | 继续轮询，Provider 尚未就绪 |
| `ready` 且 activeTurnId 为 null | 可以提交下一轮 |
| `ready` 且 activeTurnId 非 null | 该轮仍活动，查询对应 turn，不并发提交 |
| `closing` | 不再提交新轮次；已有轮次可以继续查询、等待或主动取消 |
| `closed` | 不可继续使用；检查 error 和 closeReason，保存结果 |

对话可能从 starting 直接进入 closing／closed，例如短超时或启动失败。收到 ready 不代表模型请求一定成功。

### 4.4 提交轮次

```http
POST /api/ai/v1/conversations/{conversationId}/turns
Authorization: Bearer <API_KEY>
Idempotency-Key: <TURN_REQUEST_UUID>
Content-Type: application/json
```

```json
{
  "input": {
    "instructions": "根据本轮事实返回风险分析，只返回符合 Schema 的 JSON。",
    "facts": {
      "snapshotId": "snapshot-001",
      "observedAt": "2026-10-13T00:00:00+08:00",
      "price": 123.45
    }
  },
  "output": {
    "kind": "json",
    "schema": {
      "type": "object",
      "required": ["summary", "risk"],
      "properties": {
        "summary": { "type": "string" },
        "risk": { "type": "string", "enum": ["low", "medium", "high"] }
      },
      "additionalProperties": false
    }
  }
}
```

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `input` | object | 是 | 只能包含 instructions、facts |
| `input.instructions` | string | 否 | 最多 100000 字符；任务指令，不是原生 system／developer role |
| `input.facts` | object | 否 | JSON 对象；数组应包在对象字段里 |
| `output` | object | 是 | 本轮结果格式，只包含 kind、schema |
| `output.kind` | string | 是 | `text` 或 `json` |
| `output.schema` | object | 否 | JSON 输出的受限内联 Schema；建议只在 kind=json 时提供 |

instructions 去除空白后非空，或 facts 至少有一个键，二者至少满足一个。`input: {}`、纯空白 instructions 配合空 facts 会返回 `400 empty_input`。

其他合法示例：

```json
{
  "input": { "instructions": "用中文总结以上上下文。" },
  "output": { "kind": "text" }
}
```

```json
{
  "input": { "facts": { "snapshotId": "snapshot-002", "newEvidence": ["e1", "e2"] } },
  "output": { "kind": "json" }
}
```

使用方应在后续轮次提交最新事实、时间、快照 ID，以及哪些旧事实被替代。Provider 保留对话上下文，但不保证无限记忆，旧行情不自动变成最新事实。

JSON Schema 与大小限制见第 9 节。Mac 只返回当前轮最终回答，思考、工具日志及中间文本不是最终 result。

### 4.5 查询轮次与读取结果

```bash
curl --fail-with-body \
  "$TERMRELAY_BASE_URL/api/ai/v1/conversations/$CONVERSATION_ID/turns/$TURN_ID" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY"
```

| `status` | 是否终态 | 处理 |
| --- | --- | --- |
| `accepted` | 否 | 已接受，尚未确认运行；继续轮询 |
| `running` | 否 | 执行中，也可能等待用户回答；继续查询 |
| `succeeded` | 是 | 读取 result，再做业务校验 |
| `failed` | 是 | 读取 error、可能的 rawText；不要当作成功 |
| `cancelled` | 是 | 该轮已确认取消；不是业务结果 |

`output.kind=text` 时 result 是字符串；`kind=json` 时 result 是**已解析的 JSON 值**，不要再默认 `JSON.parse(result)`。JSON 值也可能是数组、数字、boolean 或 null；不能只用 result 是否为真值判断成功，必须看 status。

查询 turn 只返回该轮结果，不回显原 input 和 output。使用方需自己保存请求及 Schema。创建／查询 conversation 通常没有最终任务 result；正常任务结果从 turn 读取。

### 4.6 取消某一轮

```bash
curl --fail-with-body -X POST \
  "$TERMRELAY_BASE_URL/api/ai/v1/conversations/$CONVERSATION_ID/turns/$TURN_ID/cancel" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY"
```

返回轮次资源。`cancelRequested: true` 只表示请求已发出，status 暂时可能仍 accepted／running。继续查询到终态：

- 正常取消确认后为 cancelled。
- 成功结果先提交时可能为 succeeded；不要覆盖已经成功的结果。
- 无法确认取消或发生连接故障时可能为 failed，error.executionOutcome 可能 unknown。
- 对已终态轮次重复取消返回原终态，不重新执行任务。
- 正常取消后，对话未过期／未关闭且运行时健康时仍可继续使用。

### 4.7 关闭对话

```bash
curl --fail-with-body -X DELETE \
  "$TERMRELAY_BASE_URL/api/ai/v1/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $TERMRELAY_API_KEY"
```

返回对话资源，通常 status=closing：

- 拒绝新轮次。
- 当前轮不被自动取消，等它成功、失败或确认取消后再停止运行时。
- 空闲时立即请求停止。
- 继续查询对话，直到 closed；重复关闭是幂等的，已 closed 时仍返回 202 和原资源。
- 不删除轮次结果；正常关闭 `error: null`、`closeReason: "explicit_close"`。

要立即停止业务：请求取消活动 turn，查询终态，再 DELETE 对话。没有 force 参数。Mac／Web 用户也可以直接停止所属运行时，这可能使活动任务变为失败。

## 5. 返回字段详解

### 5.1 对话响应示例

以下 UUID、时间、名称均为说明示例，不是可调用的真实设备：

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "kind": "conversation",
  "projectId": "api",
  "deviceId": "12345678-1234-4234-8234-123456789abc",
  "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "provider": "codex",
  "displayName": "行情分析",
  "status": "starting",
  "activeTurnId": null,
  "waitingFor": null,
  "cancelRequested": false,
  "result": null,
  "error": null,
  "actualModel": null,
  "actualEffort": null,
  "usage": null,
  "createdAt": "2026-10-12T16:00:00.000Z",
  "finishedAt": null,
  "expiresAt": "2026-10-12T17:00:00.000Z",
  "conversationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "actualProvider": "codex",
  "elapsedMs": 0,
  "links": {
    "self": "/api/ai/v1/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  }
}
```

### 5.2 成功轮次响应示例

```json
{
  "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "kind": "turn",
  "projectId": "api",
  "deviceId": "12345678-1234-4234-8234-123456789abc",
  "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "provider": "codex",
  "displayName": "行情分析",
  "status": "succeeded",
  "activeTurnId": null,
  "waitingFor": null,
  "cancelRequested": false,
  "result": {
    "summary": "当前风险可控，继续观察新证据。",
    "risk": "low"
  },
  "error": null,
  "actualModel": null,
  "actualEffort": null,
  "usage": null,
  "createdAt": "2026-10-12T16:00:05.000Z",
  "finishedAt": "2026-10-12T16:00:20.000Z",
  "expiresAt": null,
  "turnId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "conversationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "actualProvider": "codex",
  "elapsedMs": 15000,
  "links": {
    "self": "/api/ai/v1/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/turns/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }
}
```

真实响应还可能包含 model、effort、schemaHash 等可选字段，下面列明。客户端应允许未使用的响应字段存在。

| 字段 | 类型 | 适用／含义 |
| --- | --- | --- |
| `id` | string | 当前资源 ID；对话是 conversationId，轮次是 turnId |
| `kind` | `conversation`／`turn` | 资源类型 |
| `conversationId` | string | 对话 ID，两种资源都有 |
| `turnId` | string，可选 | 仅轮次资源 |
| `sessionId` | string | 对话 ID；不要误当成轮次 ID |
| `deviceId` | string | 实际目标设备 |
| `projectId` | string | 内部兼容来源，新通用调用通常为 api；不是业务项目配置 |
| `provider`／`actualProvider` | string | 请求并固定使用的 Provider |
| `displayName` | string | 对话展示名，轮次沿用 |
| `model`／`effort` | string，可选 | 创建时明确请求的值，省略时字段可能不存在 |
| `actualModel`／`actualEffort` | string 或 null | 能确认的实际值；未知时 null，不能据此猜测 |
| `status` | string | 按资源类型解释，见接口状态表 |
| `activeTurnId` | string 或 null | **对话**中用于判断活动轮次；轮次资源运行时也可能为自身 ID |
| `waitingFor` | `input`／`approval`／null | 以轮次资源为准；不要依赖对话资源反映交互等待 |
| `cancelRequested` | boolean | 轮次是否收到取消请求；不是已停止证明 |
| `result` | JSON 值或 null | 正常任务的最终结果只在 succeeded 轮次使用 |
| `error` | object 或 null | 异步执行／异常关闭错误，见第 8 节 |
| `rawText` | string，可选 | 输出解析／校验失败时的有界原回答 |
| `schemaHash` | string，可选 | 提供 output.schema 时的规范化 SHA-256，64 位十六进制 |
| `usage` | null | 当前没有精确 Token 用量，不要当作 0 |
| `createdAt` | ISO 时间字符串 | 对话／轮次被接受的时间，UTC |
| `finishedAt` | ISO 时间字符串或 null | 资源终态时间 |
| `expiresAt` | ISO 时间字符串或 null | 对话的可选到期时间；轮次为 null，不代表父对话无超时 |
| `closeReason` | string，可选 | 对话关闭请求原因，例如 explicit_close、timeout、cancel_timeout；迁移历史可能为 legacy_job |
| `elapsedMs` | number | 从创建到终态或当前时间的毫秒数，含等待，不是 Token／推理耗时 |
| `links.self` | string | 同 Server 的绝对路径，已包含 `/api/ai/v1`，不要重复拼接前缀 |

input、output、请求指纹及内部启动／取消／停止确认截止时间不返回。正常新 conversation 的 result 通常为 null；迁移旧 job 的已关闭对话可能保留历史 result，这是只读兼容，不是新任务模式。

## 6. 超时、关闭与等待

### 6.1 对话超时

`timeoutSeconds` 从创建请求被 Server 接受时起算，**不是**从 ready、第一轮或最后一次活动时起算，不随新轮次或幂等重试续期。

```text
创建：timeoutSeconds = 60
  0 秒：starting
  5 秒：ready
 50 秒：接受一轮
 60 秒：到期 → closing，拒绝新轮次，当前轮继续
 90 秒：当前轮 succeeded → 持久化结果 → 请求关闭运行时
停止确认：closed，closeReason = timeout
```

- 未设置超时：由调用方主动关闭；没有空闲自动关闭。
- 到期时空闲：请求关闭，不等待未来任务。
- 到期时等待用户回答：该轮仍未完成，会继续等；到期不会自动填写答案或取消。
- 到期后的新 turn 返回 `409 conversation_closing`；关闭完成后返回 `409 conversation_closed`。
- 原已接受轮次的同键重试仍返回原资源，不创建新轮次。
- Server 大约每秒扫描一次；新轮次准入会独立判断 expiresAt，因此即使状态查询尚显示 ready，也不能据此绕过到期限制。

### 6.2 本地等待预算不是服务端超时

区分三种时长：

| 时长 | 配置方 | 到期效果 |
| --- | --- | --- |
| HTTP 请求超时 | 使用方 HTTP 客户端 | 当前通信失败，远端是否接受需用原幂等键／ID确认 |
| 业务轮询预算 | 使用方业务代码 | 使用方停止等待，远端任务可能仍运行 |
| conversation timeoutSeconds | 创建对话正文 | 停止接受新轮次，等活动轮次终态后关闭 |

业务需要硬截止时间时，应主动取消当前轮并查询终态，然后关闭对话。不要在本地超时后换一个幂等键重做同一项有副作用的工作。

### 6.3 固定异常保护

- Provider 启动有 30 秒保护。
- Server 取消确认保护为约 10 秒，Mac 中断保护为约 5 秒；异常时停止所属运行时。
- Server 在下发关闭后有约 10 秒停止确认保护，超时标记 close_timeout。
- 这些保护不是单轮执行时限，**不会在正常运行 180 秒后取消任务**。
- closing 的对话正常情况下仍占容量，直到 Mac 停止确认；停止确认超时是异常终态，不代表已证明底层进程停止。
- Mac、Agent 或 Server 故障仍可能结束对话；“无自动到期”不是“永不退出”。

## 7. 幂等、并发与重试策略

### 7.1 幂等键

创建及轮次提交分别保存：

```text
业务操作 ID
请求路径及原正文
创建幂等键 → conversationId
每轮幂等键 → turnId
最后已确认状态及最终结果
```

同操作范围、同键、同规范化正文返回原资源；同键不同正文返回 `409 idempotency_conflict`。JSON 对象键顺序不影响指纹，数组顺序、实际值、是否省略参数等会影响指纹。不要在重试时修改 timeoutSeconds、补上默认字段或改变事实快照。

轮次范围包含父对话 ID；创建范围独立。新通用 Key 共用幂等范围，不按业务项目或调用方隔离，推荐每次真正的新操作使用全球唯一 UUID。Key 替换不应改变重试键。

已关闭／失败对话的创建键也返回原对话，不启动新运行时。只有业务明确决定开始新对话时才换新键。资源过期清理后不再保证旧键去重，调用方不能把一个键长期循环用于不同工作。

### 7.2 并发

- 同一 conversation 最多一个活动 turn。
- accepted 就已占用该对话，不能等它变 running 才视为忙碌。
- 并发新轮次返回 `409 conversation_busy`，不自动排队。
- 不同对话可并行，但每台 Mac 最多四个，并受 Provider 上限约束。
- 有不同业务角色、需要独立证据复核或隔离上下文时，用不同 conversation；需要连续分析时复用同一个。

### 7.3 重试分类

| 情况 | 推荐处理 |
| --- | --- |
| 连接错误／HTTP 响应超时 | 有界重试原路径、原幂等键、原正文；已有 ID 时优先查询 |
| `invalid_request` 等 400 | 修正参数；正文改变后是新的业务请求，使用新键 |
| 401／403 | 修正 Key／网络／权限，不盲目重试 |
| `conversation_not_ready` | 查询并等待 ready，不创建另一个对话 |
| `conversation_busy` | 查询原活动 turn，由业务门控串行化 |
| `conversation_closing`／`conversation_closed` | 不向旧对话提交新轮次；业务决定是否创建新对话 |
| `device_busy` | 调用方有界退避或提示容量不足，不无界排队 |
| `invalid_json`／`schema_mismatch` | 读取错误和受限原回答，由业务决定是否显式发起修复轮次 |
| `executionOutcome=unknown` | 标记待核实，不自动认定未执行，不自动重做有副作用的任务 |

HTTP／业务超时不等于 Mac 断线。Mac 断线、运行时退出或 Server 重启会结束外部对话；没有断线恢复、自动故障转移或任务自动重跑。

## 8. 错误处理

### 8.1 同步 HTTP 错误

典型 NestJS 错误格式：

```json
{
  "message": "conversation_busy",
  "error": "Conflict",
  "statusCode": 409
}
```

客户端优先用 HTTP status 与 message 判断，不依赖人类可读的 error 名称。错误正文在代理／框架层失败时也可能不是 JSON。

| HTTP | message／情况 | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 类型、字段、范围不符，或规范化请求超过大小限制 |
| 400 | `invalid_device_id` | 设备 UUID 不符合实际校验 |
| 400 | `invalid_idempotency_key` | 缺少或格式错误 |
| 400 | `empty_input` | instructions 和 facts 都没有有效内容 |
| 400 | `input_too_deep` | 正文嵌套超过限制 |
| 400 | `schema_too_large` | Schema 大小超限 |
| 400 | `schema_too_complex` | Schema 深度／节点数超限 |
| 400 | `unsupported_schema_keyword` | 使用了被禁止的 Schema 键 |
| 400 | `invalid_schema` | Schema 不能编译 |
| 401 | `invalid_api_key` | Key 缺失、格式错误、未知或已撤销 |
| 403 | `lan_only` | 非受信来源，或带被禁止的转发／Cloudflare 头 |
| 403 | `legacy_key_requires_replacement` | 旧版受限 Key 不允许新执行 |
| 404 | 资源／路径不存在 | ID 错、父对话不匹配、旧 Key 不可访问、历史过期，或端点不存在 |
| 409 | `capability_unavailable` | 目标设备没有公布所需 Provider |
| 409 | `device_busy` | 设备／Provider 容量已满 |
| 409 | `conversation_not_ready` | 还在启动 |
| 409 | `conversation_busy` | 同一对话已有活动轮次 |
| 409 | `conversation_closing` | 正在关闭，不接收新轮次 |
| 409 | `conversation_closed` | 对话已关闭 |
| 409 | `idempotency_conflict` | 同键不同正文 |
| 413 | 框架正文大小限制 | 原始 HTTP 请求过大，可能在业务校验前被拒绝 |
| 503 | `ai_requires_database` | Server 数据库未启用 |
| 503 | `device_offline` | 目标 Mac 当前没有可用连接 |

### 8.2 异步资源错误

HTTP 200／202 的资源响应也可能 status=failed 或 closed 且 error 非 null：

```json
{
  "code": "connection_lost",
  "message": "connection_lost",
  "executionOutcome": "unknown"
}
```

| `executionOutcome` | 正确理解 |
| --- | --- |
| `not_started` | 服务明确按未开始执行处理 |
| `confirmed` | 已确认该轮结束／输出错误，不代表业务成功或副作用回滚 |
| `unknown` | 无法确认执行结果，可能已经产生副作用 |

常见 code：

| code | 含义／处理 |
| --- | --- |
| `startup_timeout`／`startup_failed` | 启动未成功，检查 Provider 和 Mac |
| `startup_or_action_failed` | Mac 启动／动作失败的通用错误，检查模型、强度、凭据、目录与容量 |
| `runtime_exited` | 运行时退出，不能继续旧对话 |
| `connection_lost` | Mac 连接失效，结果可能未知 |
| `server_restarted` | Server 重启结束原活动资源，不恢复旧 ID |
| `agent_failed` | 智能体轮次失败 |
| `automatic_approval_failed` | Mac 自动审批无法完成，任务明确失败 |
| `invalid_json` | 最终回答不能解析为 JSON |
| `schema_mismatch` | JSON 不符合调用方 Schema |
| `output_too_large` | 输出超限；Mac 也可能先关闭运行时并返回 runtime_exited |
| `cancel_timeout` | 无法确认中断，需核实结果 |
| `close_timeout` | 无法及时确认运行时停止，需核实设备状态 |
| `lifecycle_upgraded` | 迁移旧 job 时仍在执行，历史结果标记未知 |

代码来自 Server 与 Mac，不能假设它们穷尽未来错误。未知 code 保留原错误并交给业务层，不使用成功结果替代。

`waitingFor=input` 时，当前 AI API 不提供提交答案端点；由 Mac／Web 用户回答，或使用方主动取消。审批正常由 Mac 自动处理，不需要调用方实现审批 API。

## 9. 大小、Schema、权限与运行限制

| 项目 | 当前限制 |
| --- | --- |
| 创建／轮次正文 | 规范化 JSON 的 UTF-8 大小最多 262144 字节 |
| 正文嵌套 | 递归深度不超过 32 |
| instructions | 最多 100000 字符，同时受正文总大小限制 |
| output.schema | JSON 序列化大小最多 32768 字节 |
| Schema 复杂度 | 深度最多 16，遍历节点最多 2000 |
| 最终回答 | UTF-8 大小最多 262144 字节；跨端协议也有限制 |
| rawText | 最多 32768 个 JavaScript UTF-16 代码单元，不保证保留完整原回答 |
| 设备总活动对话 | 最多 4；空闲、启动中与正常关闭中仍占容量 |
| Provider 容量 | 公布的 1～4，同时受设备总上限约束 |
| 同一对话的活动轮次 | 最多 1 |

Schema 禁止 `$ref`、`$dynamicRef`、`pattern`、`patternProperties`、`format`。当前检查遍历 Schema 的所有嵌套键，包括 properties 下的属性名，因此不要在提交的 Schema 中把这些词作为属性名。建议使用 type、properties、required、additionalProperties、enum、items 以及常规数值／长度约束；复杂业务校验留在调用方。

JSON 最终回答可以是纯 JSON，或完整 JSON 外包一层单独的 Markdown 代码块；前后解释文字、多段候选 JSON 不会被猜测提取。不要依赖 TermRelay 自动修复格式。

当前 Mac 在线周期内还存在有界去重／未确认结果保护：最多记录 10000 个创建 ID、10000 个轮次 ID，最多保留 32 个未确认终态更新。这些不是公开可配置参数，达到保护上限可能异步失败；无默认时长不等于无限次数。重新连接会结束旧外部对话，不能用断线来延续同一上下文。高频长期接入应监控这些限制，并在业务确认后安排维护／新对话。

模型上下文、认证、配额、计费与可用模型仍由实际 Provider 决定。TermRelay 的 API Key 不是模型供应商 Key，不提供 Token 精确计费或调用方配额隔离。

## 10. 可直接运行的 Python 接入示例

以下示例仅使用 Python 3.10+ 标准库，完成“能力检查 → 创建 → 一轮 JSON 分析 → 查询 → 关闭”。示例中的业务输入应替换为调用方真实任务。

说明：

- 每次真正运行示例是一个新业务请求，会创建新的幂等键；生产代码必须把键、原正文与返回 ID 保存到自己的数据库。
- 只对传输失败做最多三次同请求重试，不对业务失败偷偷换键重跑。
- 本地轮询超时明确抛错，不取消远端任务；抛错信息提供查询路径，按第 6、7 节处理。
- 示例先关闭已终态任务的对话，再报告 failed／cancelled；如果尚未查到终态就遇到网络／本地等待错误，应保留已打印的资源 ID，继续查询或显式取消／关闭。
- 示例的 600 秒等待预算只是调用方策略，不是服务端限制，可按业务调整。
- 不会输出 API Key。

保存为调用方的 `termrelay_example.py`：

```python
import json
import os
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class APIError(RuntimeError):
    def __init__(self, status, detail):
        self.status = status
        self.detail = detail
        super().__init__(f"TermRelay HTTP {status}: {detail}")


class TermRelay:
    def __init__(self, base_url, api_key):
        self.api_url = base_url.rstrip("/") + "/api/ai/v1"
        self.api_key = api_key

    def request(self, method, path, body=None, idempotency_key=None):
        data = None if body is None else json.dumps(
            body, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        request = Request(self.api_url + path, data=data,
                          headers=headers, method=method)
        for attempt in range(3):
            try:
                with urlopen(request, timeout=10) as response:
                    return json.loads(response.read().decode("utf-8"))
            except HTTPError as exc:
                raw = exc.read().decode("utf-8", errors="replace")
                try:
                    detail = json.loads(raw)
                except json.JSONDecodeError:
                    detail = raw[:1000]
                raise APIError(exc.code, detail) from exc
            except (URLError, TimeoutError, OSError) as exc:
                if attempt == 2:
                    raise RuntimeError(
                        f"Transport failed for {method} {path}; "
                        "query saved IDs or retry the identical request "
                        "with the same idempotency key"
                    ) from exc
                time.sleep(0.5 * (2 ** attempt))
        raise AssertionError("Unreachable")

    def wait(self, path, wanted, pending, budget_seconds):
        deadline = time.monotonic() + budget_seconds
        while time.monotonic() < deadline:
            resource = self.request("GET", path)
            status = resource["status"]
            if status in wanted:
                return resource
            if status not in pending:
                raise RuntimeError(
                    f"Unexpected resource state at {path}: "
                    f"status={status}, error={resource.get('error')}"
                )
            time.sleep(1)
        raise TimeoutError(
            f"Local polling budget exceeded at {path}; "
            "remote work may still be running. Do not resubmit with a new key."
        )


def main():
    base_url = os.environ["TERMRELAY_BASE_URL"]
    api_key = os.environ["TERMRELAY_API_KEY"]
    device_id = os.environ["TERMRELAY_DEVICE_ID"]
    provider = os.environ.get("TERMRELAY_PROVIDER", "codex")
    client = TermRelay(base_url, api_key)

    targets = client.request("GET", "/targets")
    target = next(
        (item for item in targets
         if item["deviceId"].lower() == device_id.lower()
         and item["online"]
         and any(p["provider"] == provider for p in item["providers"])),
        None,
    )
    if target is None:
        raise RuntimeError("Configured device/provider is not available")

    create_body = {
        "target": {"deviceId": device_id},
        "provider": provider,
        "displayName": "Third-party analysis",
    }
    for env_name, field in [
        ("TERMRELAY_MODEL", "model"),
        ("TERMRELAY_EFFORT", "effort"),
    ]:
        if os.environ.get(env_name):
            create_body[field] = os.environ[env_name]
    if os.environ.get("TERMRELAY_TIMEOUT_SECONDS"):
        timeout = int(os.environ["TERMRELAY_TIMEOUT_SECONDS"])
        if not 1 <= timeout <= 2147483647:
            raise ValueError("TERMRELAY_TIMEOUT_SECONDS is out of range")
        create_body["timeoutSeconds"] = timeout

    create_key = str(uuid.uuid4())
    conversation = client.request(
        "POST", "/conversations", create_body, create_key
    )
    conversation_id = conversation["conversationId"]
    conversation_path = f"/conversations/{conversation_id}"
    print(f"conversationId={conversation_id}", flush=True)
    ready = client.wait(conversation_path, {"ready"},
                        {"starting"}, budget_seconds=60)
    if ready["activeTurnId"] is not None:
        raise RuntimeError("Conversation already has an active turn")

    turn_body = {
        "input": {
            "instructions": "Summarize the supplied facts. Return only JSON.",
            "facts": {"snapshotId": "example-001", "observations": [1, 2, 3]},
        },
        "output": {
            "kind": "json",
            "schema": {
                "type": "object",
                "required": ["summary"],
                "properties": {"summary": {"type": "string"}},
                "additionalProperties": False,
            },
        },
    }
    turn_key = str(uuid.uuid4())
    turn = client.request(
        "POST", conversation_path + "/turns", turn_body, turn_key
    )
    turn_id = turn["turnId"]
    turn_path = conversation_path + f"/turns/{turn_id}"
    print(f"turnId={turn_id}", flush=True)
    finished = client.wait(
        turn_path, {"succeeded", "failed", "cancelled"},
        {"accepted", "running"}, budget_seconds=600
    )

    # Persist this resource/result in the caller's own storage.
    print(json.dumps(finished, ensure_ascii=False), flush=True)
    client.request("DELETE", conversation_path)
    closed = client.wait(conversation_path, {"closed"},
                         {"closing"}, budget_seconds=30)
    if closed.get("error") is not None:
        raise RuntimeError(f"Conversation closure failed: {closed['error']}")
    if finished["status"] != "succeeded":
        raise RuntimeError(
            f"Turn ended as {finished['status']}: {finished.get('error')}"
        )
    return finished["result"]


if __name__ == "__main__":
    main()
```

配置好第 2 节的环境变量后：

```bash
python3 termrelay_example.py
```

不要在验证接入代码时默认运行真实模型请求。先用假 Server／假运行时测试；真实调用必须由设备所有者和业务方明确授权。

多轮调用：保留 conversationId，每次前一轮终态后生成新的轮次幂等键，继续 POST 同一对话的 `/turns`；只在业务结束后执行 DELETE。模型／Provider 不可在轮次请求里改。

## 11. 保留、升级与验收

### 11.1 数据保留

- 资源状态、结果和幂等记录在资源结束后默认保留 30 天；到期后查询可能 404。
- 原始输入、受限原回答及详细外部事件默认保留约 24 小时，按清理扫描处理。
- 对话记录的保留从对话关闭起算，轮次从该轮终态起算；一个仍开放的对话不保证其早期轮次结果无限保留。
- 保留规则不会因为记录 TTL 自动关闭活动对话。
- 使用方提前保存业务输入、Schema、结果、错误、实际模型与快照标识，不能只依赖服务端历史。
- 没有上下文恢复接口；历史结果可查询不代表旧 Agent 进程可继续使用。

### 11.2 旧版升级

| 旧用法 | 当前用法 |
| --- | --- |
| 创建 `/jobs` 并立即执行 | 创建 conversation，等待 ready，再提交 turn |
| `oneShot`／`longLived` | 没有生命周期分类 |
| job 完成后自动退出 | 使用方关闭 conversation，或创建时设置可选 timeoutSeconds |
| 每轮 deadlineSeconds | 不接受；硬截止由调用方取消控制 |
| jobId | 保存 conversationId 和 turnId |
| profile／业务项目／grants 配置 | 不发送；只指定目标、Provider、可选模型／强度 |

停止旧版本，备份数据库，同步更新 Mac／Server／Web，执行新迁移。旧 job 规范化为已关闭 conversation，原结果和错误仍保留，可用原 job ID 调 `GET /conversations/{id}`；升级时未结束的 job 标记结果未知。迁移不会恢复旧进程，回滚也不恢复旧资源分类。

### 11.3 使用方验收清单

- Key 保存在后端，完整值从 Web 一次性复制，不使用管理标识。
- 目标设备 online 且公布所需 Provider；不用公网代理或 Cloudflare 域名调用。
- 首轮等待 ready，多个 turn 串行执行，创建和每轮幂等键持久化。
- 同键重试不重复业务执行；同键改变正文明确报冲突。
- 读取 succeeded 的 result，JSON 已解析；业务 Schema／证据有效性仍由使用方验证。
- 不传 timeoutSeconds 时由业务关闭；传入时到期不截断当前轮，之后拒绝新轮次。
- HTTP／轮询超时、取消请求和 unknown 结果都不被误判为未执行或成功。
- 取消后查询轮次终态，关闭后查询对话 closed；及时释放空闲对话。
- 断线／重启后不继续旧 ID，不自动重做可能产生副作用的任务。
- 仅在明确授权后做真实 Provider 调用，确认模型、输出质量、耗时与工具权限。

## 12. 本文对应的代码与协议

使用方无需阅读这些文件即可调用；维护本文时用它们核对，不以示例代替协议：

- `packages/contracts/ai-AiConversationRequest.schema.json`：创建参数。
- `packages/contracts/ai-AiTurnRequest.schema.json`：轮次参数。
- `packages/contracts/ai.schema.json`：Mac／Server AI 消息及 Provider 能力。
- `apps/server/src/ai/ai.controller.ts`：HTTP 路由、访问限制和响应字段。
- `apps/server/src/ai/ai.validation.ts`：输入、Schema、输出限制与指纹。
- `apps/server/src/ai/ai.service.ts`：准入、幂等、生命周期、取消和优雅关闭。
- `apps/mac/Sources/Agents/Core/AIRuntimeManager.swift`：Provider 启动、去重、执行、审批与清理。
- [服务配置](AI_SERVICE_SETUP.md)：设备所有者／管理员操作。
- [设计与边界](AI_SERVICE_DESIGN.md)：跨端职责及生命周期设计。
