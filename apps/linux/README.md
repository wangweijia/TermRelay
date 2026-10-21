# TermRelay Linux Agent

独立于 macOS App 的 **TypeScript CLI + 无界面后台服务**，目标为 Ubuntu / Xubuntu
22.04、24.04。已移除旧 Python / GTK 实现。日常聊天、模型设置、审批和问答通过现有
Server / Web 完成，执行机器只主动出站连接，不开放原始 ACP / JSON-RPC 端口。

开发环境使用仓库声明的 Node.js 22+ / pnpm；发布 `.deb` 内置**私有 Node 运行时**，
安装机器不需要预装 Node、pnpm 或 Python。不是 SEA 单文件编译，不修改系统 Node。

## 当前范围与边界

- CLI：连接、工作区授权、启动配置、Codex 路径、无浏览器配对、状态与 doctor。
- Shell：`node-pty` 真实 PTY，支持字节输入、resize、中断、停止和 Unicode 输出。
- Codex：官方 `app-server` stdio JSONL，映射消息、思考、计划、命令、文件变更、
  模型 / 推理强度、审批和用户问答。自动审批只在 Server 同步启用时执行。
- 协议：直接使用 `@termrelay/contracts` 生成的类型与 Schema，沿用设备鉴权、
  有序事件、ACK、去重和运行期间断线补传。Server 只接收工作区 ID 和展示名，不接收真实路径。
- 进程：业务逻辑全部 TypeScript；一个小型 C supervisor 只负责 OS 级 flock、
  Linux subreaper 和所属后代清理，不解析智能体协议。PTY 的原生绑定由 node-pty 提供。

**尚未完成**：Copilot / DSH ACP、AI API、
快捷任务、历史继续、文件预览、磁盘 journal 和加密钥匙环。
当前 `session add` 只保存服务启动时创建新会话的配置；每次 run 使用新执行会话 ID，
不自动提交首轮，不恢复旧任务。远程创建独立于启动配置，逐工作区显式授权。
启动配置的 Codex 启动失败会明确终止服务；远程创建失败只返回该请求的失败，
保留其他会话，不静默转换成 Shell，也不重放模型任务。

Node 运行时只随 Agent 提供；智能体 CLI 仍需用户安装和登录。
当前开发主机为 macOS，不能把本地回归或发布目录检查称为 Linux / systemd / `.deb` 实机验收。
完整进度见 [Ubuntu TODO](../../docs/UBUNTU_APP_TODO.md)。

## 从源码开发

仓库根目录，按根 README 准备 Node.js 22+ 和声明的 pnpm：

```bash
pnpm install
pnpm --filter @termrelay/linux build
node apps/linux/dist/src/cli.js --help
```

构建需 C/C++ 编译工具链（Ubuntu 使用 `build-essential`），以生成 supervisor。
node-pty 没有匹配平台预编译产物时，其 node-gyp 构建还需要 Python；它是上游原生依赖的
**构建工具**，不属于 Agent 实现，也不会作为运行依赖装进发布包。
macOS 开发构建会修正 node-pty 预编译 spawn-helper 的可执行位。

源码管理命令可使用 `pnpm linux:cli ...`；`pnpm linux:dev` 前台运行服务。
以下示例用安装后的 `termrelay-agent`，源码环境可替换为 `node apps/linux/dist/src/cli.js`。

```bash
termrelay-agent configure --server ws://服务器:3007/ws/client --name Ubuntu
termrelay-agent workspace add "$HOME/project" --name project
termrelay-agent tool codex "$(command -v codex)"
termrelay-agent session add --workspace project --provider codex
# 可选的独立远程终端：
termrelay-agent session add --workspace project --provider shell
termrelay-agent doctor
termrelay-agent run
```

工作目录必须已存在。Codex 需由同一普通用户提前安装并登录。
`doctor` 不启动真实智能体、不验证登录、不发送模型请求；`run` 才完成 Provider 握手。
LAN 的 `/ws/client` 不提供设备认证，只可用于隔离的受信开发网络。
Shell 使用 `$SHELL`，未设置时为 `/bin/bash`。

配置位于 `${XDG_CONFIG_HOME:-~/.config}/termrelay/agent.json`，可用 `--config /绝对路径/agent.json`
覆盖。私有配置采用 0600 原子写入和 fsync，持久化设备 / 工作区 / 启动配置 ID。
原 headless 版本合法的 version 1 `agent.json` 可继续使用；旧 GUI `linux.json` 不自动导入。
运行锁阻止并发修改；最多登记 128 个工作区、配置 8 个启动会话。
修改配置前先停服务；`session list` / `session remove ID` 只管理启动配置，不删除目录。

## 通过 Web / 手机远程创建

Server、Web 与对应执行端需一起升级。Server 新增 `RemoteSessionStart1792540800000`
显式迁移（`workspaces.launch_options` 和 `session_starts`）；保持 `synchronize: false`，
沿用现有部署迁移步骤。源码开发 Server 可先 `pnpm --filter @termrelay/server build`，
再使用本地开发数据库环境运行 `pnpm --filter @termrelay/server migration:run`。
不要使用生产凭据执行本地验证。

Linux 先停服务，在本机授权目录，再启动服务：

```bash
termrelay-agent workspace add "$HOME/project" --name project --allow-remote-start
# 已登记的目录改用：
termrelay-agent workspace remote-start project --allow true
# 不需要 session add；零启动配置也可等待远程创建。
termrelay-agent run
```

systemd 用户服务使用 `systemctl --user stop termrelay-agent` / `start termrelay-agent`。
撤销同样先停服务，执行 `workspace remote-start project --allow false` 后重启。
旧配置缺少此字段时默认为不授权。Mac 在“新建会话”的工作目录下勾选
“允许 Web / 手机在此目录远程创建会话”；无需实际创建本地会话，授权在 App 重启后保留，
取消勾选不影响已运行会话。

Web 顶部“新建会话”、手机会话页“新建”使用同一入口，只展示在线且已授权工作区。
Linux 提供 Shell / PTY 与已配置 Codex / ACP；Mac 按本机可用工具提供 Shell / PTY、
Codex / PTY / ACP、Copilot / ACP、DSH / ACP。Provider 的安装、登录、Key 与代理仍在执行机器管理。
模型 / 推理强度在创建成功后的会话配置中调整，默认手动审批，**创建不提交首条消息**。
每设备远程创建最多容纳 8 个活动或启动中的会话；容量不足会明确拒绝。

请求 UUID 同时作为创建幂等 ID、命令 ID 和会话 ID。Server 先持久化再投递；
后续交互必须生成新的命令 ID，不能复用创建 ID。
相同 ID / 参数只投递一次，换参数会冲突；设备在存活期间也去重。断线、Server 重启
或等待超过 60 秒后报告“结果未知”，不重投、不自动启动另一个进程；晚到的
`session.started` 可通过查询原请求对账。浏览器保存待处理请求，重开创建窗口可继续查询；
网络失败可“重新提交同一请求”，不要另生成 ID 盲目重试。结果记录保留，不自动过期，
以免历史幂等 ID 失效后重新执行。Agent 重启不会恢复原 Provider 进程。

公共 REST API 沿用 Web 的 Cloudflare Access 边界，不是外部 AI API：

- `GET /api/session-starts/targets`：在线设备的已授权工作区及工具 / 模式，不包含本地路径。
- `POST /api/session-starts`：`requestId`、`deviceId`、`workspaceId`、`toolKey`、`runtimeMode`，
  可选 `displayName`；只有 PTY 需要 `rows` / `columns`（1–1000），ACP 不接受终端参数。
- `GET /api/session-starts/:requestId`：`pending` / `accepted` / `completed` / `failed` / `unknown`。
  创建完成后会话 ID 等于 `requestId`，进入现有会话列表和交互链路。

Server 不接受任意目录、可执行文件、脚本、初始提示词或自动审批参数；设备在执行时再次校验授权。
普通远程会话保持 `origin: local`，不修改外部 AI API 会话的归属、自动审批或超时规则。
旧客户端缺少可启动能力列表，不会出现在新建目标中。真实 Ubuntu / Xubuntu、systemd、
真实 Provider 和手机浏览器的人机验收仍需在目标环境完成。

## 公网配对

```bash
termrelay-agent configure --server wss://域名/ws/client-public --name Ubuntu
termrelay-agent pair --credential-file "$HOME/.config/termrelay/device.credential"
```

在终端输出的授权网址完成现有 Cloudflare Access 授权，可使用另一台设备浏览器。
凭据仅经 Authorization Header 发送，不写入 URL、日志、状态或普通配置。
显式选择的凭据文件是 Server / 设备绑定的 **0600 明文 JSON**，不是加密钥匙环；
请勿分享或提交。新路径不覆盖已有文件；可重配更新当前已登记的凭据文件。
切换 Server 移除文件引用，不删除原凭据文件；旧授权需在 Web 撤销。

也可注入 `TERMRELAY_DEVICE_CREDENTIAL`，或使用 systemd
`CREDENTIALS_DIRECTORY/device-credential` 的原始 token 文件（不是 pair 生成的 JSON）。
读取时校验归属、模式、普通文件、大小和符号链接；服务凭据环境变量不传给子进程。
Provider 登录凭据仍由其 CLI 管理。

## 发布 `.deb`：内置 Node

在目标架构对应的 Ubuntu 22.04+ 构建机使用官方 Node 22 分发包：

```bash
pnpm install --frozen-lockfile
pnpm linux:deb
sudo apt-get install "./apps/linux/dist/termrelay-linux_0.1.0_$(dpkg --print-architecture).deb"
termrelay-agent --version
```

构建流程编译应用与 supervisor，在临时隔离 workspace 用 pnpm deploy 收集生产依赖，
避免生产安装设置影响开发工作区；再复制当前 Node 可执行文件和
匹配的 LICENSE；默认从 Node 安装根目录取 LICENSE，可用 `TERMRELAY_NODE_LICENSE` 指定匹配文件。
不在构建脚本里下载未校验的运行时。构建机 Node / OS / 架构必须匹配，
拒绝依赖外部 libnode / OpenSSL / ICU 的系统动态 Node 构建。

安装布局：

```text
/usr/bin/termrelay-agent                # 启动私有运行时；termrelay-linux 是兼容名称
/usr/lib/termrelay-linux/release/
  runtime/bin/node                     # 私有 Node，不依赖目标机 PATH 中的 Node
  runtime/LICENSE
  app/dist/src/                        # 编译后的 TypeScript
  app/dist/termrelay-supervisor
  app/node_modules/                    # 生产依赖，包含 PTY 原生模块与协议包
  release.json                         # 应用 / Node 版本和平台 / 架构
/usr/lib/systemd/user/termrelay-agent.service
```

发布包按 amd64 / arm64 分开构建，不再使用 `Architecture: all`；
原生模块与 Node 运行时不跨架构复用。系统仍需 glibc、libstdc++、libgcc 等基础库，
不是静态链接、任意 Linux 通用的单文件。卸载不删除用户配置。
Node 安全更新由后续 Agent 发布更新负责。
覆盖 22.04 / 24.04 的正式通用包应在较旧的 22.04 构建，再到两版系统验证；
24.04 本机构建产物不默认承诺向下兼容，CI 产物按构建 OS 分开标记。

## systemd 用户服务

先完成配置，确认前台可运行并退出。安装包不会自动启用服务；用同一普通用户执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now termrelay-agent.service
systemctl --user status termrelay-agent.service
journalctl --user -u termrelay-agent.service -f
termrelay-agent status

# 修改配置前停止，修改后重新启动：
systemctl --user stop termrelay-agent.service
systemctl --user start termrelay-agent.service
```

需在退出 SSH / 重启后继续运行时，由管理员显式执行 `sudo loginctl enable-linger "$USER"`。
不要以 root 运行 Agent。unit 使用私有 Node，不依赖登录 Shell 的 nvm。
Provider 路径用 `tool codex /绝对路径` 固定；Provider 所需其他工具目录需通过用户 unit override
配置 PATH，并保持相同 HOME / 登录用户。子进程 PATH 会加入当前私有 Node 的 bin 目录。
秘密不要写入命令行或公开 unit。自定义配置可在 override 清空并重设 ExecStart。

`status` 是私有本地快照，running 通过 OS flock 判断，不是实时在线探测。
停止清理所属进程；Restart=on-failure 有启动频率限制，不自动续接旧任务。
退出超时由 unit 的所属 cgroup 兜底，不按进程名称终止其他应用。

## 生命周期与可靠性

- PTY 字节与 ACP 事件严格分离；不支持的命令明确拒绝。结构化命令先 accepted，
  实际完成 / 失败后最终 ACK；RPC 超时 / 断连表示结果可能未知，不自动重放。
- 未确认事件总计最多 16 MiB，ACK 窗口 32 个事件；网络、RPC、PTY 队列也有限制。
  断线在进程存活期间按 Server watermark 补传，watermark 回退显式失败。
- journal、命令去重、待审批和实际执行会话均不落盘；停止时提示未确认输出不能恢复。
  SIGKILL / 断电不能保证内存数据保存。
- supervisor 按后代归属清理孤儿和 detached 子进程；stdio EOF / 父进程退出触发清理。
  配置锁采用 OS flock，不以 PID 文件或过期锁时间猜测所有权。
- 传输中断自动重连；认证撤销、协议错误和不可恢复错误明确报告后停止。

## 验证

```bash
pnpm linux:test
pnpm linux:contracts
pnpm check
```

普通测试使用 Node 合成 stdio Provider，不运行真实智能体或发送模型请求。
包含配置 / 凭据 / 锁、协议、真实 PTY 和实际 WebSocket 服务闭环。
`linux:contracts` 使用真实 Server 校验器检查 Linux 发出的全部结构化事件类型。
Linux 专有 subreaper 回归在其他 OS 跳过。CI 定义 Ubuntu 22.04 / 24.04 的
无显示环境回归、内置运行时打包和安装检查；arm64、真实 systemd / linger、
公网配对及当前 Codex CLI 版本仍需实机验收。
