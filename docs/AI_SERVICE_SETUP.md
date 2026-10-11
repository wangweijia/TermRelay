# 局域网 AI 服务使用说明

设计见 [AI_SERVICE_DESIGN.md](AI_SERVICE_DESIGN.md)。TermRelay 侧已加入API Key、一次性 job、长期 conversation、逐轮结果查询和 Mac 项目调用栏目。`invest` 的代码尚未修改，待办见 [INVEST_AI_SERVICE_TODO.md](INVEST_AI_SERVICE_TODO.md)。

## 1. Server 准备

使用 Node 22+ 和仓库声明的 pnpm。先构建 Server，在开发数据库上执行 migration；新增的 `AIService1791590400000` 创建 AI 数据表和会话来源字段。不要将生产凭据用于本地开发。AI API 要求数据库启用，数据库关闭时返回 `503 ai_requires_database`。

```bash
pnpm --filter @termrelay/server build
# 在已配置开发 DB_HOST / DB_NAME / DB_USER / DB_PASSWORD 的环境中执行：
pnpm --filter @termrelay/server migration:run
```

正常的开发 Compose 会在启动阶段执行迁移，见 README。本次功能开发不自动部署或迁移线上数据库。

仅将端口开放到受信 LAN／Docker 网络。AI Controller 拒绝公网来源及携带转发／Cloudflare 标识的请求；若已有 Tunnel 转发整个服务，仍需显式阻断 `/api/ai/v1/*`。API Key 是调用凭据，HTTP 不提供传输加密。Mac 使用 `/ws/client`，公网设备入口不接收 AI 服务事件。

## 2. Mac 开放 Profile

设置 → “局域网 AI 服务 Profiles”，默认值为 `[]`，即不开放执行能力。可填入：

```json
[
  {
    "id": "invest.market-analysis.v1",
    "version": 1,
    "provider": "codex",
    "capacity": 2,
    "policy": "factsOnly"
  },
  {
    "id": "invest.options-recommendation.v1",
    "version": 1,
    "provider": "codex",
    "capacity": 2,
    "policy": "factsOnly"
  }
]
```

每个 ID 唯一，version 为正整数，capacity 为 1–4。Mac 最多运行四个外部会话；空闲长期会话仍占容量。目录和 Profile 配置只保存在这台 Mac。

`factsOnly` 在新建的临时工作区执行，使用 macOS `sandbox-exec` 限制进程：禁止 fork 和执行其他二进制，工作区及普通本地文件不可写，只有独立的 Provider 状态目录可写。Codex 使用独立 CODEX_HOME，不继承用户 MCP／插件配置，仅复制本地登录凭据文件，并在结束时删除整个临时目录。需要已登录 Codex／可用凭据，以及可定位的原生 Codex 二进制；npm 安装的 macOS 平台二进制会自动定位。若依赖 CLI 包装器、自定义凭据存储或沙箱中被禁止的启动辅助进程，应改为受支持安装方式；启动失败会返回错误，不降级 PTY。

可添加 `model` 指定 Codex 默认模型、`models` 作为可请求模型白名单、`efforts` 作为强度白名单。省略时不接受调用方任意选模型／强度，使用隔离 Provider 默认模型并记录握手可确认的配置。列表是管理员授权范围，启动时仍由 Provider 验证实际可用选项，不能视为模型访问 entitlement 保证。

DSH 可配置独立 ID、`provider: "dsh"` 和 `policy: "factsOnly"`，先在 Mac 设置中保存 DeepSeek Key；不配置 model／models／efforts。DSH 在自己的临时 DSH_HOME 中执行，同样受 OS 写入／子进程限制。DSH 的自定义启动层若要求额外子进程，会明确启动失败；不放宽限制来兼容。

代码工作流仅对 Codex 开放 `policy: "workspace"`，并提供本机绝对 `directory`。工具使用 Codex workspace-write 沙箱和人工审批，不开放自动审批。此模式有意允许工作区工具操作，不适合仅输出事实分析的任务。调用方不能通过 API 改目录。修改 Profile 配置只影响新会话；关闭原会话后再创建，才能采用新配置。

## 3. 生成 API Key

打开 TermRelay Web，点击顶部“配置”（手机也有入口），或直接访问局域网 Server 的 `/settings` 页面。例如 `http://JETSON_LAN_IP:3006/settings`，本地开发为 `http://127.0.0.1:3007/settings`。不需要命令行。

1. 在“API Key”点击“生成 Key”，不需要填写项目、设备、Profile 或并发参数，Mac 不在线也可以生成。
2. 复制给可信调用方，保存到其后端的 `TERMRELAY_API_KEY` 环境配置。
3. 勾选“我已保存 Key”后关闭显示。

完整 Key 只在生成后显示一次，不保存到浏览器缓存；列表只显示标识和撤销状态，数据库只存 SHA-256 哈希。Key 不放在前端、URL 或提交到 Git。

换 Key 时点击“生成替换 Key”；新旧 Key 短期并存，调用方换好配置后再撤销旧 Key。新生成的 Key 权限相同：能调用已开放的 AI 能力、查询和控制 AI 资源，不区分项目或用途。幂等记录采用共享服务范围，调用方应使用 UUID 等不易冲突的幂等键。撤销不会自动取消已开始任务。

已有旧版项目受限 Key 不会被自动扩大权限，可继续使用或生成替换 Key 改用通用鉴权。数据库旧 projectId／grants 字段仅用于兼容，不再是新 Key 的用户配置。

Mac 的 Profile 是执行能力与工具权限配置，不是 Key 的授权清单。它只在真正提交任务时用于选择执行能力；未连接 Mac 或未开放能力时，任务不可执行，但不影响生成 Key。TermRelay 不检查调用方使用哪个项目、什么业务用途；持有人共享 AI API 访问权限，因此只向可信调用方分发。

配置页同时提供审批通知开关，后续 Server 配置统一从这个入口扩展。本机目录、Provider 凭据与执行权限仍由 Mac 管理，不能通过 Web 修改。

API Key 管理接口位于 `/api/settings/ai`，与配置页一起沿用现有 Web 的 Cloudflare Access 登录保护，登录后可通过 Tunnel 正常管理 Key；不再额外检查局域网来源或拒绝 Cloudflare／转发请求，也不新增管理员账号体系。保留同源校验及 AI Bearer Key 不能管理配置的边界。Access 保护范围必须包含 `/settings` 和 `/api/settings/ai*`，这些路径不能设置 Bypass；Server 不另行验证 Access JWT，与现有 Web 一样信任入口保护。局域网直连仍沿用现有开发模式，不应把绕过 Access 的 Server 端口暴露到公网或不可信网络。AI 调用接口 `/api/ai/v1/*` 的 LAN 限制不变。

## 4. 调用闭环

所有端点位于 `/api/ai/v1`，带 `Authorization: Bearer <API_KEY>`。先调用 `GET /targets`，确认设备在线和 Profile 已公布。请求正文不要传 projectId 或 Mac 路径。

- 一次性推荐：`POST /jobs`，带 Idempotency-Key、target、profile、provider、input、output 和可选 deadlineSeconds。轮询 `GET /jobs/{id}`，在 succeeded 时读取 result；终态后释放运行时。下一次推荐使用新幂等键，创建新 job。
- 一天内分析：`POST /conversations`，等待状态 ready。随后 `POST /conversations/{id}/turns`，每轮使用独立幂等键并提交新快照。轮询 `/conversations/{id}/turns/{turnId}` 获取结果；一天结束后 `DELETE /conversations/{id}`。
- 中断：job 使用 `/jobs/{id}/cancel`，长期会话使用 `/conversations/{id}/turns/{turnId}/cancel`。202 表示已请求，查询确认 cancelled 或其他终态。Mac／Web 也能中断、审批及关闭。

长期会话只能串行，忙碌返回 409；离线返回 503，不排队。Mac 断线、运行时退出或 Server 重启时结束外部会话，旧 ID 不恢复；已经运行但无法确认结果时 error.executionOutcome 为 unknown，调用方不要据此认定“没有执行”。

JSON 支持受限内联 Schema；不支持 `$ref`、正则表达式和 format 校验，复杂业务校验由调用方完成。最终回答解析失败返回 invalid_json，不符 Schema 返回 schema_mismatch，可读取受限 rawText 由调用方决定如何修复。精确用量未知为 null。

轮询不依赖长连接。HTTP 请求断开不关闭会话，Mac 设备连接断开才结束外部运行时。第一版不包含 SSE、设备别名或会话恢复。

## 5. 验证与保留

状态、结果和幂等记录默认保留结束后 30 天，原始输入与详细事件默认 24 小时。外部事件不写 Mac 的持久化 RelayOutbox；运行时结束清理其临时目录，未确认结果只在当前连接生命周期内暂存。调用方保存需要长期使用的业务结果。

```bash
pnpm check
pnpm --filter @termrelay/server test
pnpm --filter @termrelay/web build
# 可选 OS 沙箱及真实 Codex／DSH 启动握手验证，不发送模型请求：
TERMRELAY_RUN_AI_SANDBOX_PROBE=1 pnpm mac:test
# 可选 MySQL 持久化探针；只允许 127.0.0.1 / termrelay_dev，先执行迁移：
TERMRELAY_RUN_AI_MYSQL_PROBE=1 DB_HOST=127.0.0.1 DB_PORT=13307 \
  DB_NAME=termrelay_dev DB_USER=termrelay_dev DB_PASSWORD=termrelay-dev-only \
  pnpm --filter @termrelay/server probe:ai:mysql
```

普通测试使用假运行时。Codex／DSH 的真实启动验证须显式开启集成探针，真实推理与业务输出质量应在项目接入前另行验收。

已验证系统沙箱阻止子进程和工作区写入、允许独立 Provider 状态写入，以及当前本机 Codex／DSH 的无推理启动握手。启动成功不代表登录有效、模型请求成功或投资结论可用。
