# TermRelay Linux

独立于 `apps/mac` 的 Linux 桌面客户端，目标系统为 Ubuntu / Xubuntu 22.04、24.04，
使用系统 Python 3.10+、GTK 3 和 VTE。GNOME / Xfce 共用同一份应用和 `.deb`，
不依赖 Swift、Xcode、Electron 或正在运行的 macOS App。Wayland 和 X11 使用 GTK 的系统后端。

## 首版范围

支持本地多标签真实 PTY、选择工作目录、登录 Shell、ANSI / 中文终端显示、
`Ctrl+Shift+C/V` 复制粘贴、窗口 resize、Ctrl-C、停止和退出清理；最多同时运行 8 个会话。
可在 Shell 内手动运行已安装的 Codex / Copilot / DSH CLI，但仍然属于 PTY，
不会显示 ACP 消息、审批或模型控件。

复用现有 Server 的 `/ws/client`、`/ws/client-public` 和 Web 终端，
支持设备注册、心跳、远程输入 / resize / interrupt / stop、命令去重和 ACK、
进程存活期间的断线重连与按序补传。工作区真实路径与子进程留在 Linux；
只向 Server 发布随机工作区 ID 和目录显示名，不发布远程新建权限。
Server 必须同时更新到接受 `platform: linux` 的版本。平台保存在原有 JSON capabilities 字段，
本次不改变数据库表结构，不需要 migration。

**尚未实现**：ACP 适配器与结构化审批、快捷任务、AI API Provider、
历史继续、工作区文件预览、应用重启后的输出恢复、系统钥匙环持久化。
首版不是 macOS App 的完整功能平替；以上功能也不会被上报为可用能力。

完整缺口、优先级、依赖与验收标准见 [Ubuntu / Xubuntu App TODO](../../docs/UBUNTU_APP_TODO.md)。

## 从源码运行

在 Ubuntu / Xubuntu 的桌面会话中：

```bash
sudo apt-get update
sudo apt-get install python3 python3-gi gir1.2-gtk-3.0 gir1.2-vte-2.91 python3-websocket

# 仓库根目录；无需启动 Mac App，也无需安装 Python pip 包
pnpm linux:dev
# 或完全不依赖 Node / pnpm：
PYTHONPATH="$PWD/apps/linux" /usr/bin/python3 -m termrelay
```

必须使用系统 `/usr/bin/python3`，不要使用缺少 apt GI 绑定的 virtualenv。
点击“新建 Shell”选择工作目录即可离线使用，不要求 Server 在线。
Shell 使用 `$SHELL`，未设置时使用 `/bin/bash`；CLI 的安装与登录由用户自行完成。

## 连接 Server / Web

隔离的受信 LAN 开发环境使用 `ws://服务器:3007/ws/client`，点击“连接”。
这一入口不提供设备认证，不要暴露到公网或不受信网络。
Server、MySQL 和 Web 的启动步骤沿用根目录 README；Web 通过 Linux 设备下的 PTY 会话交互。

公网使用 `wss://域名/ws/client-public`，点击“公网配对”，在弹出的浏览器完成
现有 Cloudflare Access 登录及配对码确认。配对成功后点击“连接”。
也可在密码输入框粘贴现有设备凭据。公网只允许 TLS，凭据只经 Authorization Header 发送，
不会放在 URL、日志或本地配置里。凭据仅保留在进程内存，退出后需要重新配对；
旧授权可在 Web 配置中撤销。Xfce 不要求 GNOME Keyring。

设备 UUID 和最近的 Server URL 保存在
`${XDG_CONFIG_HOME:-~/.config}/termrelay/linux.json`（文件权限 `0600`）。
同一次运行不能切换到其他 Server，避免将已经确认的会话序号和输出混入另一台 Server。
可断开后重新连接同一 Server；需要切换 Server 时退出 App 后重新打开。

## 输出与进程生命周期

- 本地界面、PTY、网络各有独立有界队列；界面读取输出不等待 Server 成功。
- 所有会话尚未被 Server 确认的输出总量最多 16 MiB。离线仍可启动和操作终端，
  但达到该上限时会明确报错并停止产生日志的会话，不会悄悄丢弃旧输出并伪造完整历史。
  因此长期离线的大量输出不适合这一首版。VTE 本地回滚保留 10000 行。
- 每次 Server ACK 后释放已确认输出；重连先发布工作区及会话，再按 Server watermark
  补传缺口，最后报告结束。Server watermark 回退时显式拒绝补传，避免无声丢历史。
  输出 journal 只在内存里，App 重启不能继续旧进程或补传旧输出。
  关闭时若仍有运行中会话或未确认输出，会要求确认并提示数据不会保留。
- 每个 PTY 有独立 supervisor。Linux supervisor 作为 child subreaper 收养孤儿进程；
  停止、关闭 App 或 App 异常退出造成控制管道关闭时，仅按父子归属清理自己的后代，
  不按进程名终止其他终端或 CLI。主动停止先发 SIGTERM，1 秒后升级为 SIGKILL。
- 最多同时运行 8 个会话、每次打开 App 最多创建 128 个会话；已结束标签保留供查看，
  不自动清除其等待补传的数据。

## 构建 / 安装 `.deb`

在 Ubuntu / Xubuntu（安装了 `dpkg-deb`）的仓库根目录：

```bash
pnpm linux:deb
# 或 bash apps/linux/build-deb.sh
sudo apt-get install ./apps/linux/dist/termrelay-linux_0.1.0_all.deb
termrelay-linux
```

包不包含原生扩展，声明 `Architecture: all`；GTK / VTE / WebSocket 由 apt 解析为目标机器的架构。
安装后可在应用菜单中搜索 **TermRelay Linux**。删除包使用 `sudo apt-get remove termrelay-linux`；
个人配置不会被自动删除。

## 验证

```bash
pnpm linux:test
# Ubuntu / Xubuntu 的真实 GTK/VTE 冒烟检查（需 xvfb）：
sudo apt-get install xvfb
TERMRELAY_GUI_TEST=1 PYTHONPATH="$PWD/apps/linux" \
  xvfb-run -a /usr/bin/python3 -m unittest discover -s apps/linux/tests -v
```

测试不会启动真实 AI CLI 或发起模型请求。非 Linux 环境跳过 subreaper 清理检查；
没有桌面依赖时跳过 GTK 冒烟检查。提交的 CI 分别在 Ubuntu 22.04 / 24.04 的 Xvfb
以及最小 Xfce 会话中运行图形入口、真实 PTY 和打包检查；未运行 CI 前不能视为目标系统已验收。
发布前还应在实际 Ubuntu GNOME / Xubuntu Xfce 桌面上确认中文输入法、全屏 TUI、
本地与 Web 双向操作、断网重连、配对撤销及停止后台 CLI。
