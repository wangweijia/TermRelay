# TermRelay macOS 端任务进展

> 评估日期：2026-09-10  
> 当前阶段：M0——可编译工程骨架与接口基线  
> 评估范围：`apps/mac` 现有源码、测试、项目规划及 Git 提交记录

## 总体结论

macOS 端目前仍处于早期工程骨架阶段。SwiftUI 应用外壳、基础配置模型、会话状态机和部分抽象接口已经建立，但 TermRelay 的核心终端中继链路尚未实现。

- 工程骨架完成度：约 20%。
- Mac MVP 功能完成度：约 10%～15%。
- 当前可实际使用程度：约 0%～5%。
- 当前可以完成：构建并显示 SwiftUI 空壳界面、保存 Server URL 和设备 ID。
- 当前无法完成：启动 AI CLI、显示真实终端、连接 Server 或远程控制会话。

以上比例是基于当前规划任务数量和关键路径权重的工程估算，不是正式验收数据。

## 已完成内容

### 1. macOS 工程骨架

- 已建立 Swift 6 Package。
- 最低目标平台为 macOS 14。
- 已建立 SwiftUI `App` 入口、主窗口和设置窗口。
- `swift build` 已于 2026-09-10 验证通过。

相关文件：

- `apps/mac/Package.swift`
- `apps/mac/Sources/AppShell/TermRelayApp.swift`

### 2. 基础 SwiftUI 界面

主界面当前包括：

- TermRelay 标题。
- 连接状态指示。
- 设置入口。
- 无会话时的空状态页面。

尚未提供创建会话入口、真实会话列表或终端视图。

相关文件：`apps/mac/Sources/AppShell/ContentView.swift`。

### 3. Server 设置与设备 ID

已实现：

- Server WebSocket URL 输入框。
- Server URL 通过 `UserDefaults` 持久化。
- 首次启动生成随机 `device_id`。
- 后续启动复用已保存的 `device_id`。
- 设置页展示 Device ID 和“重新连接”按钮。

当前“重新连接”按钮只把 UI 状态更新为 `connecting`，不会创建 WebSocket 或发起真实连接。

相关文件：

- `apps/mac/Sources/AppShell/AppModel.swift`
- `apps/mac/Sources/AppShell/ServerSettingsView.swift`

### 4. 连接状态模型

已定义以下连接状态以及对应显示颜色：

- `connected`
- `connecting`
- `offline`
- `degraded`

这些状态目前没有接入真实网络连接生命周期。

相关文件：`apps/mac/Sources/Remote/ConnectionState.swift`。

### 5. 会话模型和状态机

`ManagedSession` 当前包含：

- 会话 UUID。
- 工作目录 URL。
- CLI 工具 ID。
- 会话状态。

已实现以下合法状态转换：

```text
starting → running → stopping → finished
    └───────────────→ failed
```

当前模型尚未关联 PTY 进程、终端窗口、Server 会话、输出缓冲或进程生命周期。

相关文件：`apps/mac/Sources/Session/ManagedSession.swift`。

### 6. 终端与 CLI 工具抽象

已定义：

- `TerminalRenderer`：接收终端字节和尺寸变化。
- `CLIToolAdapter`：为 CLI 工具生成启动配置。
- `LaunchConfiguration`：描述可执行文件、参数、目录和环境变量。

目前只有接口，没有 SwiftTerm、PTY 或具体 CLI Adapter 实现。

相关文件：

- `apps/mac/Sources/Terminal/TerminalRenderer.swift`
- `apps/mac/Sources/Tools/CLIToolAdapter.swift`

### 7. 初始单元测试

已编写两个 `ManagedSession` 状态机测试：

- 正常状态转换。
- 已结束会话不能重新运行。

2026-09-10 验证时，当前系统只选择了 `/Library/Developer/CommandLineTools`，工具链找不到 `XCTest`，因此测试未能执行。Mac 主程序本身已经构建成功；该问题属于本机测试工具链配置，不是测试断言失败。

相关文件：`apps/mac/Tests/ManagedSessionTests.swift`。

## 分阶段进度

### 阶段 0：终端与协议探针

| 工作项 | 状态 | 备注 |
| --- | --- | --- |
| 建立最小 SwiftUI/AppKit macOS App | 基本完成 | 当前为 Swift Package 形式的 SwiftUI 外壳 |
| 集成 SwiftTerm | 未开始 | `Package.swift` 尚无 SwiftTerm 依赖 |
| 使用 PTY 在指定目录启动 Codex | 未开始 | 尚无 PTY 实现 |
| 验证颜色、中文、resize、方向键、复制和全屏 TUI | 未开始 | 依赖 SwiftTerm/PTY 探针 |
| 验证 PTY 输出分流至本地终端和 WebSocket | 未开始 | 尚无输出分发器和 WebSocket |
| 验证 Codex 结构化协议能力 | 未开始 | 尚无 CodexAdapter |

阶段 0 当前约完成 1/6，核心技术风险尚未完成实机验证。

### 阶段 1：Mac App 单机功能

| 工作项 | 状态 | 备注 |
| --- | --- | --- |
| Server URL 设置 | 部分完成 | 已持久化，尚未校验和实际连接 |
| Device ID 持久化 | 已完成 | 使用 `UserDefaults` |
| 自动连接和设备注册 | 未实现 | 无 WebSocket 客户端 |
| NSOpenPanel 目录选择 | 未实现 | 无新建会话流程 |
| CLI 工具选择器 | 未实现 | 无对应 UI |
| CodexAdapter | 未实现 | 只有通用协议 |
| 多窗口和 ManagedSession | 部分完成 | 只有内存模型，无独立终端窗口 |
| 菜单栏驻留 | 未实现 | 无 `MenuBarExtra` 或 AppKit 生命周期管理 |
| 退出确认和进程清理 | 未实现 | 尚无受管进程 |
| 本地终端输入、停止和恢复 UI | 未实现 | 依赖 PTY 与终端视图 |

### 阶段 2：Server 与 Mac App 闭环

以下 Mac 侧能力均尚未实现：

- WebSocket 建连与自动重连。
- `device.register` 和心跳。
- 会话注册和状态同步。
- 终端输出上传。
- 远程输入、resize、中断和停止。
- 基于 `session_id` 的命令路由。
- `command_id` 幂等处理。
- 输出 `seq`、ACK 和断线补传。
- 本地有界 EventJournal。

共享协议中已有部分 Swift 生成类型，但尚未接入 Mac Remote 层。

### 阶段 3：管理页面联动

Mac 端尚未具备与管理页面联动所需的实时终端、远程输入、审批或通知事件能力。

### 阶段 4：发布与加固

以下产品化工作尚未开始：

- 正式 Xcode App 工程及 Release 配置。
- App Sandbox 与 entitlement 设计。
- Keychain 秘密管理。
- GRDB/SQLite 本地数据存储。
- App 图标和正式菜单。
- Developer ID 签名与 Apple 公证。
- 安装包或自动升级方案。
- 崩溃恢复和生产日志。

## 当前运行效果

当前运行 Mac App 时，预期行为是：

1. 打开 TermRelay 主窗口。
2. 显示离线状态和空会话页面。
3. 可以进入设置页修改 Server URL。
4. 可以查看持久化的 Device ID。
5. 点击“重新连接”后只更新界面状态。

当前无法创建终端、启动 Codex、连接 Server 或接受远程控制。

## MVP 验收情况

根据开发实现文档中的 15 项 MVP 验收标准，目前还没有任何一项完整通过。第 1 项中的 Server URL 和持久化 Device ID，以及第 2～3 项所依赖的会话数据模型已经有局部实现，但均未形成可验收的端到端能力。

## 提交记录判断

Mac 端现有代码来自项目初始化提交：

```text
89a1d34 项目初始化
```

后续提交 `846f673 数据库逻辑修改` 主要推进 Server 数据库、Docker 和环境配置，没有继续修改 `apps/mac`。因此 Mac 端在初始骨架建立后尚未进入核心功能开发。

## 下一步优先级

建议先完成最小纵向终端探针，再扩展 UI 和远程管理能力：

1. 引入 SwiftTerm，并建立 `TerminalContainerView`。
2. 实现 `PTYProcess`，先在指定目录启动普通 shell。
3. 接通终端键盘输入、输出、resize、Ctrl-C 和退出清理。
4. 在 PTY 中启动 Codex，并验证中文、颜色、全屏 TUI 和大量输出。
5. 实现输出双路分发：本地 SwiftTerm 渲染和有界批处理回调。
6. 接入 `URLSessionWebSocketTask`，完成注册、心跳和自动重连。
7. 建立单会话的端到端远程输入输出闭环。
8. 单会话稳定后，再实现多窗口、工作区授权、ACK 和断线补传。

完成第 1～5 项后，Mac 端才算通过阶段 0；完成第 6～7 项后，才具备首个可演示的 TermRelay 纵向闭环。

## 维护方式

后续每次推进 Mac 端任务时，应同步更新：

- 文档顶部的评估日期和当前阶段。
- 对应任务表中的状态及备注。
- 已通过的构建、测试和实机探针结果。
- 新发现的阻塞项和下一步优先级。

