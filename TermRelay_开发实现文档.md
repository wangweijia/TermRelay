# TermRelay：开发实现文档

> 版本：v1.2  
> 用途：直接指导建仓、编码、联调和验收  
> 产品定位：通用 AI CLI 终端与远程控制平台，Codex 只是首个适配工具

## 产品命名

产品正式名称为 **TermRelay**：

- Term 代表 Terminal。
- Relay 代表中继、转发和远程接力。
- 名称不绑定 Codex、模型厂商或某一种 AI CLI。
- 产品宣传语：**Your terminals, within reach.**
- 中文释义：让你的终端，随时触手可及。

统一命名：

| 对象 | 名称 |
| --- | --- |
| 产品 | TermRelay |
| macOS App | TermRelay.app |
| Git 仓库 | termrelay |
| Mac 工程/源码目录 | TermRelay.app / apps/mac |
| Server 工程/镜像 | termrelay-server / termrelay/server |
| 协议模块/源码目录 | @termrelay/contracts / packages/contracts |

## 1. 开发范围

系统开发两个应用和一套语言无关的通信契约：

| 项目 | 部署位置 | 形态 | 核心职责 |
| --- | --- | --- | --- |
| termrelay-mac | macOS | Swift 原生 TermRelay.app | 多窗口终端、PTY、启动 AI CLI、连接 Server、管理会话 |
| termrelay-server | 任意 Docker 主机 | NestJS + Vue 3 单容器 Web 服务 | 管理页面、HTTP API、WebSocket、设备、会话、审批和数据 |
| termrelay-contracts | 仓库共享目录 | JSON Schema | Swift 与 TypeScript 共同使用的消息协议 |

不开发独立 Mac CLI、后台 Helper、launchd Agent 或独立部署的 Web 前端。Mac App 必须保持运行，Server 才能管理本机 CLI 会话。

外部依赖：

- SwiftTerm：Mac 终端解析与渲染。
- Cloudflare Tunnel/Access：Web 管理页面的公网入口与用户身份认证。
- MySQL：复用部署环境中现有的 Docker MySQL。
- AI CLI：使用 Mac 上已经安装的 Codex、Claude Code 等工具。

## 2. 整体架构

~~~mermaid
flowchart TB
    Browser["外部浏览器"] --> CF["Cloudflare Access + Tunnel"]
    CF --> Server["Docker Server：页面、API、WebSocket"]
    Server --> MySQL["Docker MySQL"]
    MacA["局域网 TermRelay.app A"] <--> Server
    MacB["局域网 TermRelay.app B"] <--> Server
    MacA --> ToolA["AI CLI：PTY + 可选协议适配"]
    MacB --> ToolB["AI CLI：PTY + 可选协议适配"]
~~~

连接规则：

- 外部浏览器通过 Cloudflare Access + Tunnel 访问 Server，不直接连接 Mac。
- Mac App 与 Server 位于可信局域网，通过 Server 局域网地址直接连接，不经过 Cloudflare。
- 每个 Mac App 只维护一条到 Server 的 WebSocket，不实现配对、设备密钥或身份认证。
- 同一 App 的多个终端窗口通过 session_id 复用这条连接。
- Server 下发创建会话、输入、审批和停止命令。
- App 上传终端输出、会话状态和结构化工具事件。
- AI CLI 在真实 Mac 上运行，访问真实项目目录和本机环境。

## 3. Mac App

### 3.1 技术栈

- Swift 6。
- SwiftUI：设置页、会话列表、窗口外壳和菜单栏。
- AppKit：NSOpenPanel、窗口控制和终端承载。
- SwiftTerm：VT100/Xterm 解析、终端状态和渲染。
- Foundation URLSessionWebSocketTask：Server WebSocket。
- Security/Keychain：仅保存 AI CLI API Key 等本机秘密，不保存设备认证凭据。
- GRDB + SQLite：本地配置索引、会话元数据和待补传事件。

### 3.2 产品形态

Mac 端只有一个原生 App：

~~~text
TermRelay.app
├── AppShell
│   ├── 菜单栏
│   ├── Server 设置
│   ├── 连接状态
│   └── 会话列表
├── TerminalWindow
│   ├── SwiftTerm 终端
│   ├── 当前目录
│   ├── 当前 CLI 工具
│   └── 会话状态
├── SessionCore
│   ├── SessionManager
│   ├── TerminalSession
│   ├── PTYProcess
│   └── EventJournal
├── RemoteCore
│   ├── ServerConnection
│   ├── DeviceIdentity
│   ├── MessageRouter
│   └── ReconnectManager
└── ToolCore
    ├── CLIToolAdapter
    ├── CodexAdapter
    └── FutureAdapters
~~~

“Agent”不再是一个单独程序。原有设备连接、PTY 和会话管理能力全部作为 App 内部模块实现。

### 3.3 App 生命周期

- App 启动后读取 Server 局域网地址并自动连接。
- 连接失败时按指数退避自动重连，并提供手动“重新连接”按钮。
- 关闭最后一个终端窗口不退出 App。
- App 没有窗口时继续驻留菜单栏并维持 Server 连接。
- 用户可以从菜单栏重新打开已有会话或创建新会话。
- 用户明确选择“退出 App”时，展示仍在运行的会话数量。
- MVP 中确认退出后终止全部受管 CLI，不保留孤儿进程。
- App 崩溃或完全退出后，Server 无法继续控制本机 CLI。

MVP 不实现 App 退出后会话继续运行。若后续需要该能力，再引入独立 Helper 或 tmux 类持久化层。

### 3.4 Server 配置与设备自动注册

设置页字段：

| 字段 | 说明 |
| --- | --- |
| Server URL | Server 局域网 WebSocket 地址，例如 ws://192.168.1.100:3000/ws/client |
| 设备名称 | Server 页面展示名称 |
| 自动连接 | 默认开启 |
| 连接状态 | connected、connecting、offline、degraded |
| 重新连接 | 立即重建 WebSocket |

首次连接与自动注册：

1. App 首次启动时生成并持久化一个随机 device_id；它只用于识别设备，不是认证凭据。
2. 用户配置 Server 的局域网 WebSocket 地址和设备名称。
3. App 建立 WebSocket，并发送 device.register，包含 device_id、设备名称、App 版本和工具能力。
4. Server 根据 device_id 自动创建或更新设备记录。
5. 后续启动复用相同 device_id 自动连接并更新设备信息。

Mac App 不实现配对码、设备密钥对、公钥注册、签名认证、Service Token 或解除绑定流程。device_id 保存在 UserDefaults 或本地 SQLite；AI CLI API Key 等真正的秘密仍保存在 Keychain。

### 3.5 新建终端会话

用户选择“文件 → 新建会话”：

1. App 使用 NSOpenPanel 弹出目录选择器。
2. 用户选择本地项目目录。
3. App 显示 AI CLI 工具选择器。
4. App 校验工具路径和运行环境。
5. App 创建 session_id 和 TerminalSession。
6. App 在指定 cwd 创建 PTY 并启动工具。
7. App 打开新的终端窗口。
8. App 向 Server 注册会话。

目录选择：

~~~swift
let panel = NSOpenPanel()
panel.canChooseDirectories = true
panel.canChooseFiles = false
panel.allowsMultipleSelection = false
~~~

新建窗口 UI：

~~~text
新建会话

工作目录：~/Desktop/codes/invest
CLI 工具：Codex
环境配置：默认

[取消] [启动]
~~~

UI 不使用“新建 Codex”之类的固定名称。Codex 仅出现在工具选择项中。

### 3.6 多窗口与会话

每个窗口对应一个独立 ManagedSession：

~~~swift
struct ManagedSession: Identifiable {
    let id: UUID
    let directory: URL
    let toolID: String
    let terminalSession: TerminalSession
    var remoteState: RemoteSessionState
}
~~~

~~~text
Mac App
├── Window 1 → session-001 → invest → Codex → PTY 1
├── Window 2 → session-002 → guitar-ai → Claude Code → PTY 2
└── Window 3 → session-003 → other-project → Codex → PTY 3
~~~

Server 的所有会话命令必须包含 session_id，App 根据 session_id 路由到对应 PTY 或工具适配器。

### 3.7 工作区授权

用户首次通过 NSOpenPanel 选择目录后，可以选择“允许远程再次启动”。App 保存授权工作区：

~~~yaml
workspaces:
  invest:
    display_name: invest
    path: /Users/weijiawang/Desktop/codes/invest
    remote_start_allowed: true
~~~

App 只向 Server 同步 workspace_id、显示名称和可用状态。真实绝对路径保存在 Mac 本地。

Server 远程创建会话时只能选择已经授权的 workspace_id，不能提交任意本地路径。未授权目录只能由用户在 Mac App 中通过 NSOpenPanel 首次打开。

### 3.8 终端渲染

MVP 使用 SwiftTerm，不自行实现终端模拟器。

SwiftTerm 负责：

- ANSI、VT100 和 Xterm 控制序列。
- ANSI、256 色和 TrueColor。
- 粗体、斜体、下划线和删除线。
- 光标、清屏、换行和终端尺寸变化。
- 中文、Unicode、Emoji 和组合字符。
- 选择、复制、搜索、鼠标和超链接。
- 滚动缓冲与可选 Metal 渲染。

App 通过 Swift Package Manager 引入：

~~~text
https://github.com/migueldeicaza/SwiftTerm
~~~

SwiftTerm 的 AppKit TerminalView 通过 NSViewRepresentable 嵌入 SwiftUI。TerminalSession 持有终端视图和 PTY，SwiftUI View 不直接管理子进程。

~~~swift
struct TerminalContainerView: NSViewRepresentable {
    let session: TerminalSession

    func makeNSView(context: Context) -> TerminalView {
        session.terminalView
    }

    func updateNSView(_ view: TerminalView, context: Context) {}
}
~~~

保留 TerminalRenderer 协议隔离具体组件，后续可以评估替换为 libghostty；MVP 不使用 API 仍在快速变化的 libghostty，也不使用只提供解析、不负责完整 UI 的 libvterm。

### 3.9 PTY 数据分发

PTY 输出必须同时进入本地终端和 Server：

~~~text
AI CLI
   ↓ PTY bytes
TerminalSession
   ├──→ SwiftTerm 本地渲染
   └──→ OutputBatcher → ServerConnection
~~~

实现要求：

- 本地渲染不等待 Server。
- 输出按 20～50ms 或 4～16KB 聚合后发送，避免逐字符 WebSocket。
- Server 断线时只缓存限定大小的数据。
- 每个数据块携带 session_id 和 seq。
- Server 远程输入经过权限检查后写入对应 PTY。
- terminal.resize 更新 PTY 行列数。
- terminal.interrupt 映射为对应进程组的 SIGINT。

### 3.10 CLI 工具抽象

基础能力不能依赖 Codex 或某一种结构化协议。所有工具首先作为通用 PTY 程序运行，支持结构化协议的工具再加载适配器。

~~~swift
protocol CLIToolAdapter {
    var toolID: String { get }
    var displayName: String { get }

    func detect() async throws -> ToolCapabilities
    func makeLaunchConfiguration(
        directory: URL,
        environment: EnvironmentProfile
    ) throws -> LaunchConfiguration
    func handleRemoteAction(
        _ action: RemoteAction,
        session: TerminalSession
    ) async throws
}
~~~

工具定义：

~~~swift
struct CLIToolDefinition: Codable, Identifiable {
    let id: String
    let displayName: String
    let executablePath: String
    let arguments: [String]
    let environmentProfile: String?
    let integrationType: IntegrationType
}

enum IntegrationType: String, Codable {
    case terminal
    case codexAppServer
}
~~~

第一版提供 CodexAdapter，但 App、窗口、会话和协议不能使用 Codex 专属命名。后续可以增加 ClaudeCodeAdapter、GeminiCLIAdapter 或 CustomCLIAdapter。

### 3.11 PTY 与结构化协议

| 能力 | 基础 PTY | 工具适配器 |
| --- | --- | --- |
| 启动和显示 CLI | 支持 | 不需要 |
| 终端输入、尺寸和 Ctrl-C | 支持 | 不需要 |
| 远程镜像和按键操作 | 支持 | 不需要 |
| 助手消息和精确状态 | 不保证 | 适配器提供 |
| 工具调用与审批语义 | 不保证 | 适配器提供 |
| 精确任务完成事件 | 不保证 | 适配器提供 |

阶段 0 验证时，Codex 0.151.0 没有 ACP CLI 入口，但提供 `codex app-server` 结构化协议以及连接它的 `codex --remote` TUI 模式。项目已决定直接使用官方 App Server Protocol 实现 Codex 结构化增强，不通过 `codex-acp`；完整决策见 [`docs/ADR-001-CODEX-APP-SERVER.md`](docs/ADR-001-CODEX-APP-SERVER.md)，通用智能体接口和接入流程见 [`docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md`](docs/STRUCTURED_AGENT_ADAPTER_DESIGN.md)。App Server 是 CodexAdapter 的可选增强，不是 App 核心协议。MVP 先使用已经验证的 PTY 完成远程镜像和输入；之后以 Mac 本地 stdio 子进程实现 App Server Adapter，将原生事件转换成 TermRelay Contract，并保留 PTY 回退。

### 3.12 环境管理

App 启动 CLI 时显式设置：

- cwd：用户选择或已经授权的目录。
- executablePath：工具绝对路径。
- PATH、HOME、SHELL 和代理变量。
- TERM、cols 和 rows。

工具和环境配置在设置页管理。API Key 等秘密进入 Keychain，不进入普通配置、日志或 Server。

App 提供“检查工具”功能，至少验证：

~~~bash
command -v codex
codex --version
command -v git
git --version
~~~

检查结果上报工具 ID、路径是否有效和版本；不上传秘密环境变量。

## 4. Server 单体服务

### 4.1 技术栈与部署

Server 工程名为 termrelay-server，Docker 镜像名为 termrelay/server。它以单个无状态容器运行，兼容 linux/amd64 和 linux/arm64：

- Node.js 22。
- NestJS + Fastify。
- Vue 3 + TypeScript + Vite 构建管理页面。
- Vue Router 管理页面路由，Pinia 管理设备、会话、终端、审批和通知状态。
- Element Plus 提供管理界面组件。
- xterm.js 显示远程终端。
- TypeORM + mysql2 连接现有 MySQL。
- Pino JSON 日志。

Web UI 在源码层与 NestJS 分目录开发，但不独立部署。生产构建时，Vite 输出静态资源到 Server 的 dist/public，由 NestJS 直接托管。生产环境只有一个 Docker 镜像、一个容器、一个进程入口和一个 HTTP 端口，不创建独立前端容器或 Nginx。

通信入口：

| 客户端 | 地址示例 | 网络与认证 |
| --- | --- | --- |
| 外部浏览器 | https://termrelay.example.com、wss://termrelay.example.com/ws/web | 通过 Cloudflare Access + Tunnel |
| 局域网 Mac App | ws://192.168.1.100:3000/ws/client | 局域网直连，不经过 Cloudflare，不做应用层认证 |

Cloudflare Tunnel 指向 Server 的同一 HTTP 端口。Cloudflare Access 必须覆盖整个公网域名及所有路径，使公网访问始终经过用户认证；Mac App 使用局域网 IP 访问，因此不受 Access 影响。Server 和路由器不开放公网入站端口。

### 4.2 Server 模块

| 模块 | 功能 |
| --- | --- |
| WebUiModule | 托管 Vue 构建产物、SPA fallback 和静态资源 |
| AuthModule | 校验浏览器请求中的 Cloudflare Access 上游身份 |
| ClientGateway | Mac App 局域网 WebSocket、自动注册、心跳和路由 |
| BrowserGateway | 向管理页面推送实时事件 |
| DeviceModule | 设备列表、状态和工具能力 |
| WorkspaceModule | 已授权工作区元数据 |
| SessionModule | 会话创建、状态机、路由和停止 |
| TaskModule | 初始任务、后续输入和幂等 |
| ApprovalModule | 结构化审批请求和决策 |
| EventModule | 事件入库、序号、补取和页面推送 |
| AuditModule | 用户与设备操作审计 |

ClientGateway 中的“认证”职责删除，改为局域网连接、device.register、心跳、能力上报和 session_id 路由。Server 仍校验消息结构、device_id、command_id 和 session_id，但这些属于协议校验，不是身份认证。

### 4.3 页面

| 路由 | 功能 |
| --- | --- |
| GET / | 设备、会话和待审批概览 |
| GET /devices | Mac App 设备与在线状态 |
| GET /devices/:id | 工作区、会话和工具能力 |
| GET /sessions/new | 从已授权工作区创建远程会话 |
| GET /sessions/:id | 终端镜像、输入、状态、审批和停止 |
| GET /approvals | 结构化待审批列表 |
| GET /audit | 审计查询 |

浏览器终端使用 xterm.js。它仅渲染 Mac App 上传的 PTY 字节，不运行本地进程。

Web UI 使用响应式状态管理处理实时交互：

- HTTP API：首次加载、历史查询、创建会话、提交配置和审批决定。
- Browser WebSocket：终端输出、设备在线状态、会话状态、审批请求、审批结果和通知推送。
- Pinia：统一保存设备、会话、已打开终端标签、待审批数量和未读通知。
- xterm.js：每个已打开的 Web 终端标签对应一个 session_id；不可见标签限制渲染和缓冲量。

通知分为页面内提示、通知中心和可选浏览器系统通知。审批状态以 Server 和 MySQL 为准，前端提交决定后必须等待 Server 确认，不能只在本地修改为已处理。

### 4.4 MySQL

数据库按环境完全隔离：

| 环境 | 地址 | 数据库 | 运行用户 |
| --- | --- | --- | --- |
| 本地开发 | Docker `mysql:3306`；宿主机 `127.0.0.1:3307` | `termrelay_dev` | `termrelay_dev` |
| 最终部署 | `192.168.8.134:3306` | `termrelay_prod` | `appuser` |

生产配置示例：

~~~env
DB_ENABLED=true
DB_HOST=192.168.8.134
DB_PORT=3306
DB_NAME=termrelay_prod
DB_USER=appuser
DB_PASSWORD=通过环境变量或 Docker Secret 注入
~~~

要求：

- 开发和生产使用独立数据库，不复用现有 `shared` 数据库。
- 长期运行的生产容器使用最小权限用户，只拥有 `termrelay_prod` 的 CRUD 权限。
- root 只用于显式的一次性 migration，不进入长期运行容器。
- 应用运行时不使用 root。
- 生产环境使用 TypeORM migration。
- 生产环境禁止 synchronize。
- events 对 session_id + seq 建立唯一索引。
- commands 对 command_id 建立唯一索引。

### 4.5 数据表

| 表 | 主要字段 |
| --- | --- |
| devices | id, name, public_key, status, capabilities, last_seen_at |
| cli_tools | id, device_id, tool_key, display_name, version, capabilities |
| workspaces | id, device_id, display_name, available, remote_start_allowed |
| sessions | id, device_id, workspace_id, tool_key, status, state_version |
| events | id, session_id, seq, type, payload, created_at |
| commands | id, command_id, device_id, session_id, type, status |
| approvals | id, session_id, risk, request, decision, expires_at |
| audit_logs | id, actor, action, target, result, trace_id, created_at |

## 5. 通信协议

### 5.1 WebSocket

| 连接 | 地址 | 用途 |
| --- | --- | --- |
| Client WebSocket | ws://SERVER_LAN_IP:3000/ws/client | Server 与局域网 Mac App 双向命令和事件，无认证 |
| Browser WebSocket | wss://PUBLIC_HOST/ws/web | 通过 Cloudflare Access，向管理页面推送状态和终端数据 |

统一消息信封：

~~~json
{
  "type": "terminal.output",
  "protocolVersion": "1",
  "messageId": "uuid",
  "deviceId": "device-001",
  "sessionId": "session-001",
  "seq": 100,
  "sentAt": "RFC3339",
  "payload": {}
}
~~~

协议源文件使用 JSON Schema，分别生成 Swift Codable 类型和 TypeScript 类型。禁止把 TypeScript 类型包当作 Swift 客户端的协议来源。

### 5.2 Server 下发命令

~~~text
session.start
session.input
session.stop
session.terminate
terminal.resize
terminal.interrupt
approval.decide
device.drain
~~~

远程 session.start 只能引用 App 已授权的 workspace_id 和可用 tool_key。所有命令携带 command_id；App 对重复 command_id 返回原结果，不重复执行。

### 5.3 Mac App 上传事件

~~~text
device.register
device.heartbeat
device.capabilities
tool.capabilities
workspace.registered
session.started
session.state_changed
terminal.output
approval.requested
session.finished
session.failed
~~~

每个会话事件使用单调递增 seq。App 将未确认事件写入本地 Journal，重连后从 Server 已确认序号继续补传。

## 6. 仓库结构

~~~text
termrelay/
├── apps/
│   ├── mac/
│   │   ├── Package.swift
│   │   ├── Sources/AppShell/
│   │   ├── Sources/Terminal/
│   │   ├── Sources/Session/
│   │   ├── Sources/Remote/
│   │   ├── Sources/Tools/
│   │   └── Tests/
│   ├── server/
│   │   ├── src/auth/
│   │   ├── src/devices/
│   │   ├── src/workspaces/
│   │   ├── src/sessions/
│   │   ├── src/events/
│   │   └── dist/public/
│   └── web/
│       ├── src/pages/
│       ├── src/components/
│       ├── src/stores/
│       └── src/router/
├── packages/
│   └── contracts/
│       ├── envelope.schema.json
│       ├── commands/
│       ├── events/
│       └── generated/
│           ├── swift/
│           └── typescript/
├── deploy/
│   ├── server/Dockerfile
│   ├── server/compose.yaml
│   └── cloudflare/
└── docs/
~~~

Swift App 不进入 pnpm workspace。NestJS、Vue 3 与 `packages/contracts` 使用同一个 pnpm workspace 和同一套构建命令。`packages/contracts` 是 Mac App、Server 和 Web UI 的共同协议源；Web 的生产产物仍输出到 `apps/server/dist/public`，因此部署形态保持单镜像、单容器和单端口。

## 7. MVP 开发顺序

### 阶段 0：终端与协议探针

- 建立最小 SwiftUI/AppKit macOS App。
- 集成 SwiftTerm。
- 使用 SwiftTerm/PTY 在指定 cwd 启动 Codex。
- 验证颜色、中文、窗口 resize、方向键、复制和全屏 TUI。
- 验证 PTY 输出分流到本地渲染与 WebSocket。
- 验证 Codex App Server 是否能与期望的终端模式结合，并保留纯 PTY 回退。

### 阶段 1：Mac App 单机功能

- Server 局域网地址设置、持久化 device_id 和自动注册。
- NSOpenPanel 目录选择。
- CLI 工具配置与 CodexAdapter。
- 多窗口和 ManagedSession。
- 菜单栏驻留和退出确认。
- App 内终端输入、停止和会话恢复 UI。

### 阶段 2：Server 与 Mac App 闭环

- Server 单体项目和 MySQL migration。
- 局域网 Client WebSocket、device.register 与设备自动登记。
- 会话注册、心跳和状态。
- 终端输出、远程输入和停止。
- command_id、seq、ACK 和断线补传。

阶段 2 先完成与 CLI 类型无关的 PTY 纵向闭环。Codex App Server 不阻塞该阶段；闭环通过后，
按 ADR-001 的 A～E 清单增加 Codex 结构化模式。禁止让 Server/Web 直接依赖 App Server 原始
JSON-RPC，也不在此阶段引入 `codex-acp`。

### 阶段 3：管理页面

- Vue 3 + Vite + Pinia 管理页面基础工程。
- 设备、工具、工作区和会话标签页。
- 会话终端镜像。
- 远程输入和停止。
- 实时通知、待审批和审计。

### 阶段 4：外网与加固

- Cloudflare Tunnel/Access，仅用于浏览器公网入口。
- 确认 Mac App 使用局域网地址，不经过 Cloudflare。
- 防火墙限制 Server 端口只能由可信局域网以及 cloudflared 所在主机或容器网络访问。
- 多设备与多会话测试。
- WebSocket 背压和日志脱敏。
- 应用签名、公证和升级方案。

## 8. MVP 验收

1. Mac App 启动后通过局域网地址自动连接 Server、使用持久化 device_id 自动注册，并能手动重新连接。
2. 用户通过 NSOpenPanel 选择目录和 CLI 工具并打开新窗口。
3. 每个窗口拥有独立 PTY、session_id 和 CLI 进程。
4. 多个窗口能够同时运行不同目录和不同 CLI 工具。
5. SwiftTerm 正确显示颜色、中文、Emoji、光标和全屏 TUI。
6. Server 实时显示指定会话的终端输出。
7. Server 输入只进入目标 session_id 对应的 PTY。
8. Server 只能远程启动 App 已授权的工作区。
9. 关闭窗口后 App 仍驻留；明确退出 App 时终止全部受管会话。
10. 断线重连后事件能够按照 seq 补传且不重复。
11. App、协议和页面不使用 Codex 作为产品级固定命名。
12. 新增第二种 CLI 工具时无需修改 SessionManager、终端渲染或基础协议。
13. Web UI 使用 Vue 3 构建，但生产环境仍只有一个 Server 镜像、一个容器和一个 HTTP 端口。
14. 外部浏览器通过 Cloudflare Access 访问；Mac App 局域网连接不要求配对码、设备密钥或认证凭据。
15. 页面可以实时显示设备状态、会话标签、终端输出、审批请求和未读通知，WebSocket 重连后状态能够恢复。

## 9. 第一批开发 Issue

1. 初始化 Swift macOS App 和 Server 项目。
2. 集成 SwiftTerm 并完成单窗口本地命令 Demo。
3. 实现 PTY 输出分发和输入写入。
4. 实现 NSOpenPanel 目录选择和工具选择器。
5. 实现 ManagedSession 和多窗口。
6. 实现菜单栏驻留、关闭窗口和退出确认。
7. 定义 CLIToolAdapter，并实现首个 CodexAdapter。
8. 实现 Server 局域网地址设置、持久化 device_id、自动注册和自动重连。
9. 定义 JSON Schema 协议并生成 Swift/TypeScript 类型。
10. 创建 Server 单体应用和 MySQL migration。
11. 实现局域网 Client WebSocket、device.register 和心跳。
12. 实现 session_id 路由、终端上传和远程输入。
13. 实现 command_id、seq、ACK 和本地 EventJournal。
14. 实现 Vue 3、Vite、Pinia、Element Plus 管理页面基础工程，并由 NestJS 托管构建产物。
15. 实现设备、会话标签、xterm.js 终端、通知中心、远程工作区启动、审批和审计。
16. 配置 Cloudflare、应用签名并完成端到端验收。
