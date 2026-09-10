# TermRelay Server 端任务进展

> 更新日期：2026-09-11
>
> 当前阶段：Server S2——设备连接、持久化与只读查询闭环已完成
>
> 下一阶段：Server S3——会话注册与终端输出接收

## 总体结论

Server 已具备第一个跨 WebSocket、内存状态、MySQL 和 HTTP API 的可重复纵向切片：设备可以注册、发送心跳、断开并按顺序持久化，Server 重启后仍可查询设备记录。

- 工程基础完成度：约 55%。
- Server MVP 功能完成度：约 30%～35%。
- 阶段 2“Server 与 Mac 闭环”完成度：约 40%。
- 技术可行性：可行，当前未发现需要改变总体架构的阻塞项。
- 当前核心缺口：真实 Mac 网络客户端、Session 状态、终端事件、浏览器广播和远程命令。

以上比例是基于关键路径权重的工程估算，不是正式验收数据。

## 已完成能力

### 工程与运行环境

- NestJS 11、Fastify、原生 `ws` Adapter。
- Vue 静态构建产物由 Server 单容器托管。
- TypeScript 构建、类型检查与自动化测试。
- MySQL 8 migration，`synchronize: false`。
- 本地开发库与 Jetson 最终部署库隔离。
- 本地 Docker Compose 开发栈已启动并通过健康检查。
- 本地与 Jetson 数据库迁移和数据库健康检查均已实测。

环境与运行命令见 `docs/ENVIRONMENTS.md`。

### HTTP

| 路由 | 状态 | 说明 |
| --- | --- | --- |
| `GET /health` | 完成 | 数据库启用时执行 `SELECT 1`，异常返回 503 |
| `GET /api/devices` | 完成 | 返回持久化设备并覆盖当前进程中的实时状态 |
| `GET /api/devices/:id` | 完成 | 返回设备详情，不存在时返回 404 |

### Client WebSocket（S1）

`/ws/client` 已实现：

- AJV Draft 2020-12 Envelope 与 payload 运行时校验。
- `device.register` 注册及 `device.registered` 确认。
- 每个 `device_id` 唯一连接，新连接替换旧连接。
- `device.heartbeat` 状态和活动会话数更新。
- 未注册超时、心跳超时、主动断开与离线状态。
- 非法 payload、未注册心跳和协议版本拒绝。

真实网络探测已通过：

```bash
pnpm --filter @termrelay/server probe:s1
```

```text
✓ registration acknowledgement and heartbeat
✓ unregistered heartbeat rejected
✓ unsupported protocol version rejected
Server S1 WebSocket probe passed.
```

### 设备持久化与查询（S2）

已实现：

- `DeviceEntity` 与现有 `devices` migration 对齐。
- `DeviceRepository` 持久化注册、心跳和离线快照。
- Server 启动时把遗留的在线、中间态设备标记为离线。
- `DevicesService` 合并 MySQL 记录与当前内存实时状态。
- 同一设备写操作按事件顺序串行执行，避免注册、心跳、断开并发造成重复主键或旧状态覆盖新状态。
- HTTP 查询会等待当前待完成的持久化操作。
- MySQL 使用毫秒精度的 `ON UPDATE CURRENT_TIMESTAMP(3)`，避免同一秒内更新时间早于创建时间。
- 数据库关闭时，Device API 仍可返回当前进程内的瞬时设备状态。

真实数据库端到端探测已通过：

```bash
pnpm --filter @termrelay/server probe:s2
```

```text
✓ device register, heartbeat, and disconnect persisted in order
✓ device detail and list APIs returned persisted state
Server S2 device persistence probe passed.
```

## 数据库结构

初始 migration 定义 8 张业务表：

| 表 | 当前业务接入状态 |
| --- | --- |
| `devices` | 已接入 Entity、Repository、Service 与 HTTP API |
| `cli_tools` | 尚未接入 |
| `workspaces` | 尚未接入 |
| `sessions` | 尚未接入 |
| `commands` | 尚未接入 |
| `events` | 尚未接入 |
| `approvals` | 尚未接入 |
| `audit_logs` | 尚未接入 |

生产运行账户保持最小业务权限，migration 管理权限与应用运行权限分离。凭据只通过环境变量注入，不进入仓库。

## 协议状态

当前 8 个 JSON Schema 均已通过检查：Envelope、Device Register、Device Registered、Device Heartbeat、Terminal Output、Session Start、Command ACK、Protocol Error。

运行时校验已经接入 Server。仍有一项协议技术债：TypeScript/Swift 的 `generated` 类型目前是手写引导版本，尚未建立从 JSON Schema 自动生成并在 CI 检查无漂移的正式流程。

## 自动化与实测

当前 Server 自动化测试共 18 项，覆盖：

- AppModule 无数据库模式依赖注入与生命周期。
- 协议 Envelope/payload 校验。
- 注册、心跳、断开、重复设备连接替换。
- 注册超时与心跳超时。
- Gateway 正常与异常路径。
- Device Service 的内存模式、实时覆盖和同设备串行落库。
- Device Controller 列表、详情与 404。

已实测：

- Contracts 检查、Server 构建、类型检查、自动化测试。
- 无数据库和本地开发数据库两种启动模式。
- `/health`、Web 静态资源、两个 WebSocket 入口。
- MySQL migration 正向执行、本地 Compose 开发栈。
- S1 真实 WebSocket 网络探测。
- S2 WebSocket → MySQL → HTTP API 端到端探测。
- Jetson 生产数据库建库、migration 记录与应用账户权限。

尚未验证：

- migration 回滚与升级失败恢复。
- 当前代码的生产镜像重新构建和 Jetson 应用部署。
- WebSocket 大量输出、背压、多设备和多会话。
- 真实 Mac App 与 Server 的网络联调及断线重连。
- Cloudflare Access、客户端身份认证和速率限制。

## 当前安全边界

当前实现只适合本机或受控局域网开发，不能直接暴露到公网：

- `/ws/client` 尚无设备 credential、签名、来源限制和速率限制。
- `/ws/web` 尚未验证 Cloudflare Access 身份。
- 生产 Compose 的 `127.0.0.1:3000` 适合 Tunnel 访问，但不提供 Mac 局域网直连入口。

在真实设备联调前，应确定 LAN 入口和设备认证方案；在公网发布前必须完成 Cloudflare Access 与安全限制。

## 下一步优先级

1. 实现 Session Entity/Repository/Service，将 `session.start` 写入 MySQL。
2. 接收 `terminal.output`，按 `session_id + seq` 校验、去重并持久化事件。
3. 将会话状态和终端输出广播到 `/ws/web`。
4. 实现浏览器到目标 Mac 的单会话输入。
5. 增加 command ACK、超时与 `command_id` 幂等。
6. 接入真实 Mac App 的 register/heartbeat/reconnect Client。
7. 增加 Session、Event 与端到端测试，补测背压和断线恢复。
8. 建立 JSON Schema 到 TypeScript/Swift 的正式代码生成。
9. 接入 Cloudflare Access、设备身份和生产网络限制。

完成第 1～4 项后，Server 才拥有第一个可演示的终端中继闭环。

## 下次开发交接

开始前运行：

```bash
pnpm contracts:check
pnpm --filter @termrelay/server test
```

验证 S1/S2 时，先按 `docs/ENVIRONMENTS.md` 启动本地数据库和当前 Server，然后执行：

```bash
pnpm --filter @termrelay/server probe:s1
pnpm --filter @termrelay/server probe:s2
```

明确未完成：

- Session Repository 和 `session.start` 路由。
- `terminal.output` 接收、顺序校验、存储与 Web 广播。
- 远程输入、resize、interrupt、stop、ACK 和断线补传。
- 真实 Mac App 网络客户端和 Device Web 页面。
- 正式 Schema 代码生成。
- Cloudflare Access、设备认证、限流和生产网络加固。

后续每个阶段应同步更新本文件中的阶段、实测结果、安全边界和下一优先级。
