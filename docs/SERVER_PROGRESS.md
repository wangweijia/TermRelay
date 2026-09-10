# TermRelay Server 端任务进展

> 评估日期：2026-09-10
>
> 当前阶段：M0/M1——可运行工程骨架与数据库基线
>
> 评估范围：`apps/server`、`packages/contracts`、`deploy/server`、Web 静态托管链路及 Git 提交记录

## 总体结论

Server 目前处于工程骨架阶段。NestJS 服务、数据库结构、WebSocket 入口、健康检查和部署配置已经建立，但设备注册、会话管理、终端中继和远程控制等核心业务尚未实现。

- 工程基础完成度：约 35%。
- Server MVP 功能完成度：约 10%～15%。
- 阶段 2“Server 与 Mac 闭环”完成度：约 15%～20%。
- 当前端到端可使用程度：0%。
- 当前可以完成：启动 Server、查看健康状态、加载 Web 占位页、建立 WebSocket 连接。
- 当前无法完成：注册 Mac、创建会话、传输终端输出、远程输入或恢复断线会话。

以上比例是基于规划任务数量和关键路径权重的工程估算，不是正式验收数据。

## 已完成内容

### 1. NestJS Server 工程

已经建立：

- NestJS 11。
- Fastify HTTP Adapter。
- 原生 `ws` WebSocket Adapter。
- TypeScript 构建配置。
- Shutdown Hook。
- Web 静态文件托管入口。

相关文件：

- `apps/server/src/main.ts`
- `apps/server/src/app.module.ts`
- `apps/server/package.json`

2026-09-10 实际验证通过：

- Contracts TypeScript 构建。
- Server TypeScript 类型检查。
- Server NestJS 构建。
- Server 无数据库模式启动。

### 2. 健康检查

已提供：

```http
GET /health
```

无数据库模式实测返回：

```json
{
  "status": "ok",
  "service": "termrelay-server",
  "database": "disabled"
}
```

启用数据库后，健康检查将执行 `SELECT 1`；数据库不可用时返回 503。无数据库路径已经实测，数据库连接路径尚未实测。

相关文件：`apps/server/src/health/health.controller.ts`。

### 3. WebSocket 入口骨架

| 入口 | 当前能力 |
| --- | --- |
| `/ws/client` | 握手、记录连接、处理断开、检查协议版本 |
| `/ws/web` | 握手、记录连接、处理断开 |

实测两个入口均能建立连接：

```text
/ws/client open
/ws/web open
```

向 `/ws/client` 发送不支持的协议版本时，连接会以 1002 关闭：

```text
/ws/client close 1002 unsupported protocol version
```

当前只有进程内连接集合，没有设备映射、消息路由、持久化或 Gateway 之间的事件转发。

相关文件：

- `apps/server/src/realtime/client.gateway.ts`
- `apps/server/src/realtime/browser.gateway.ts`

### 4. MySQL 初始数据库结构

已经定义 8 张表：

| 表 | 用途 |
| --- | --- |
| `devices` | Mac 设备 |
| `cli_tools` | 设备上的 CLI 工具 |
| `workspaces` | 已授权工作区 |
| `sessions` | 终端会话 |
| `commands` | Server 下发命令 |
| `events` | 有序会话事件 |
| `approvals` | 审批请求 |
| `audit_logs` | 审计日志 |

数据库设计已经考虑：

- `command_id` 唯一约束。
- `session_id + seq` 唯一约束。
- 会话 `state_version`。
- 表间外键关系。
- 事件过期时间。
- 审批状态和风险级别。
- 审计 Trace ID。
- `utf8mb4` 字符集。
- 开发与生产数据库隔离。

相关文件：

- `apps/server/src/database/migrations/0001_initial.sql`
- `apps/server/src/database/migrations/1788966000000-initial-schema.ts`
- `apps/server/src/database/database.config.ts`

当前没有 TypeORM Entity、Repository 或业务 Service，因此 Server 尚不会读写这些表。

### 5. 数据库迁移机制

已经配置：

- `synchronize: false`。
- TypeORM migration。
- 开发环境先迁移再启动 Server。
- 生产环境显式运行一次性迁移。
- 生产运行用户与迁移用户分开。
- SQL migration 被正确复制到构建产物。

相关文件：

- `apps/server/src/database/database.module.ts`
- `apps/server/src/database/data-source.ts`
- `docs/ENVIRONMENTS.md`

迁移源码和构建产物完整，但当前机器未安装 Docker/MySQL，因此没有在真实 MySQL 8.4 上执行。

### 6. 协议 Schema 基线

目前有 7 个 JSON Schema：

- Envelope。
- Device Register。
- Device Heartbeat。
- Terminal Output。
- Session Start。
- Command ACK。
- Protocol Error。

协议文件检查实测通过：

```text
Validated 7 contract schemas.
```

已有 TypeScript 和 Swift 引导类型，但存在两个限制：

1. `generated` 类型仍是手写引导文件，没有真正从 Schema 自动生成。
2. Server 只使用 TypeScript `Envelope` 类型，没有运行时 JSON Schema 校验。

TypeScript 类型在运行时会被擦除，因此当前不能阻止客户端发送结构错误的消息。

相关目录：`packages/contracts`。

### 7. 单容器页面托管

Web 构建产物写入：

```text
apps/server/dist/public
```

从正确的 `apps/server` 工作目录启动 Server 后，实测：

```text
GET /                         200
GET /assets/index-*.js        200
```

说明 Server 托管 Vue 构建产物的链路可用。

页面本身仍为 M0 占位页，目前没有：

- 设备数据。
- HTTP API 请求。
- WebSocket 客户端。
- xterm.js 终端。
- Pinia 业务 Store。
- 审批、通知或审计页面。

Web 构建成功，但主 JavaScript 包约 1.02 MB，Vite 报出大于 500 KB 的代码分割警告。这不是当前核心阻塞项。

## 阶段 2：Server 与 Mac 闭环

| 工作项 | 状态 | 说明 |
| --- | --- | --- |
| Server 单体项目 | 完成 | 可以构建、启动和托管页面 |
| MySQL migration | 开发完成、未实机验证 | 当前机器没有 Docker/MySQL |
| `/ws/client` WebSocket | 基础完成 | 只能握手和检查协议版本 |
| `device.register` | 未实现 | 没有验证、写库或更新设备 |
| 设备在线/离线管理 | 未实现 | 连接没有映射到 Device ID |
| 心跳与超时 | 未实现 | 没有 stale/offline 判定 |
| 会话注册与状态同步 | 未实现 | 没有 Session Service |
| 终端输出接收 | 未实现 | `terminal.output` 不会被处理 |
| 输出转发到 Web | 未实现 | 两个 Gateway 没有连接 |
| 远程输入 | 未实现 | Server 不能向 Mac 发命令 |
| resize、interrupt、stop | 未实现 | 缺少命令类型和路由 |
| `command_id` 幂等 | 仅数据库约束 | 没有业务逻辑 |
| `seq` 去重 | 仅数据库约束 | 没有事件处理逻辑 |
| ACK | 仅 Schema | 没有等待或状态更新 |
| 断线补传 | 未实现 | 没有 Journal 协商 |
| 状态快照恢复 | 未实现 | 没有连接恢复流程 |

阶段 2 当前最准确的描述是：入口和数据模型存在，但纵向业务链路尚未开始。

## HTTP API 状态

目前唯一 HTTP API 是：

```text
GET /health
```

以下规划 API 均不存在：

- `/api/devices`
- `/api/sessions`
- `/api/workspaces`
- `/api/commands`
- `/api/approvals`
- `/api/audit-logs`

实测 `GET /api/devices` 返回 404。

## 安全状态

当前安全能力基本未实现，只适合本机或隔离局域网开发。

### Cloudflare Access

已经预留以下环境变量：

```text
CF_ACCESS_AUD
CF_ACCESS_TEAM_DOMAIN
```

代码尚未读取或验证它们。`BrowserGateway` 中只有待实现的 Cloudflare Access 校验 TODO，实测未经身份验证即可连接 `/ws/web`。

### Mac 客户端身份

`/ws/client` 当前没有：

- Device credential。
- 签名或 Token。
- 来源 IP 限制。
- 注册握手限制。
- 消息速率限制。

因此该端点不能安全暴露到普通办公网或公网。

### 生产端口冲突

`deploy/server/compose.prod.yaml` 当前映射：

```yaml
127.0.0.1:3000:3000
```

这允许同主机 Cloudflare Tunnel 访问，但其他 Mac 无法通过局域网地址直接连接，与架构中的“Mac 通过局域网连接 Server”存在冲突。

进入 Mac–Server 联调前需要选择以下方案之一：

- 绑定指定 LAN IP，并用防火墙限制可信设备。
- 增加一个只面向可信局域网的反向代理入口。

## 测试与验证现状

### 已通过

- Contracts TypeScript 构建。
- Server TypeScript 类型检查。
- NestJS 构建。
- 7 个 Schema 文件检查。
- 无数据库模式启动。
- `/health` 返回 200。
- Web 页面和静态资源返回 200。
- `/ws/client` 握手。
- `/ws/web` 握手。
- 错误协议版本以 1002 关闭。

### 尚未验证

- MySQL migration 正向执行。
- Migration 回滚。
- 数据库健康检查。
- Docker 镜像构建。
- Compose 开发栈。
- 生产镜像启动。
- WebSocket 大量输出和背压。
- 多设备和多会话。
- 断线重连。
- Cloudflare Access。

仓库内没有 Server 单元测试、集成测试或端到端测试。当前机器没有安装 Docker，因此数据库和容器部分无法实测。

## 当前实际能力

当前可以：

1. 启动 NestJS Server。
2. 查看健康状态。
3. 加载 Vue 占位页面。
4. 连接两个 WebSocket 入口。
5. 拒绝协议版本不为 `1` 的 Client 消息。
6. 准备 MySQL 初始表结构。

当前不能：

1. 注册或展示一台 Mac。
2. 保存设备状态。
3. 创建会话。
4. 接收终端输出。
5. 把终端输出推送给浏览器。
6. 从浏览器向 Mac 发送输入。
7. 停止或中断远端会话。
8. 处理审批。
9. 恢复断线会话。
10. 验证浏览器或 Mac 身份。

## 下一步优先级

建议先打通最小纵向闭环，再扩充管理页面：

1. 增加运行时 Envelope 和 payload Schema 校验。
2. 实现 Device Repository 和 `device.register`。
3. 建立 WebSocket 连接与 `device_id` 的映射。
4. 实现心跳、断开和超时离线状态。
5. 实现 Session Repository 和会话注册。
6. 接收 `terminal.output`，校验 `session_id + seq`。
7. 把终端输出实时广播到 `/ws/web`。
8. 实现浏览器到目标 Mac 的单会话输入。
9. 增加 ACK、命令超时和幂等。
10. 补齐数据库、Gateway 和端到端测试。
11. 最后接入 Cloudflare Access 和生产网络限制。

完成第 1～8 项后，Server 才算拥有第一个真正可演示的 TermRelay 闭环。

## 维护方式

后续推进 Server 任务时，应同步更新：

- 文档顶部的评估日期和当前阶段。
- 阶段 2 任务表的状态和说明。
- 实际通过的构建、数据库、HTTP 和 WebSocket 验证。
- 安全边界及部署入口变化。
- 新发现的阻塞项和下一步优先级。
