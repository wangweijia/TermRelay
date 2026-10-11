# TermRelay 跨 Provider Skill 管理 TODO

状态：待实现；本文件记录方案，不代表这些接口已经可用。

## 目标与范围

由 Mac App 统一登记 Skill 来源、绑定项目执行配置、选择会话技能和生成版本快照，由各 Provider Adapter 完成具体加载。支持 Codex、Copilot、DSH，并为后续 Provider 提供文本注入兼容方式。

统一的是技能选择、分发和版本；不同 AI 的工具能力与遵循效果仍有差异。指定 Skill 不自动增加 MCP、工具权限或脚本依赖。已有全局 Skill 不会因选择某个 Skill 而自动禁用。

## 第一阶段：本地来源与显式选择

### Skill 格式与来源

- [ ] 采用 Agent Skills 的目录格式：`SKILL.md` 加可选 `references/`、`scripts/`、`assets/`。
- [ ] 支持选择单个 `SKILL.md`，登记其所在目录作为完整技能包。
- [ ] 支持添加多个来源目录，扫描其中的 Skill；允许现有技能留在项目目录、个人目录或其他本地位置。
- [ ] 新项目推荐 `.agents/skills/`；已有目录无需迁移。
- [ ] 解析并校验名称、说明、文件编码、大小及资源引用；扫描深度与数量设置明确上限。
- [ ] 检查真实路径和符号链接，资源读取限制在授权技能包内。
- [ ] 为每个来源和 Skill 分配稳定 ID；重名按来源区分，不静默覆盖。
- [ ] 来源失效或格式错误在管理页面明确显示，单个来源失败不影响其他来源。

### App 管理与项目执行配置

- [ ] 增加 Skill 管理页：添加、移除登记、刷新、搜索、预览与有效状态。
- [ ] 展示名称、说明、来源位置及各 Provider 的加载支持情况。
- [ ] 增加项目执行配置：配置 ID、名称、设备、工作区、默认 Provider、默认 Skill、可选 Skill。
- [ ] 一个配置可绑定多个 Skill，同一个 Skill 可供多个配置使用。
- [ ] 项目配置与本地目录访问必须显式授权；API 的 `projectId` 标签不能自动获得权限。
- [ ] 区分“项目可用 Skill”和“本次指定使用 Skill”；第一阶段优先实现显式选择。
- [ ] 新建手动 ACP 会话时支持多选 Skill，创建前校验 Provider 能力与依赖。
- [ ] 长期对话创建时固定 Skill 集合；第一阶段通过新建对话更换集合。
- [ ] PTY 模式单独评估，不把 ACP 加载操作混入终端字节链路。

### 会话快照与依赖

- [ ] 在创建会话时复制完整技能包到 TermRelay 管理的会话目录。
- [ ] 固定 `SKILL.md`、参考文件、脚本和模板内容，保存整个包的版本指纹。
- [ ] 将相对资源引用解析到会话快照，避免原文件修改影响正在执行的任务。
- [ ] 快照可读范围按会话授权；纯数据沙箱不能因加载 Skill 扩大工作区或进程权限。
- [ ] 检查 Skill 声明的工具、MCP 和运行环境依赖；不能满足时明确提示。
- [ ] Skill 内容作为任务指令提供，不提升为系统权限；加载不等于执行脚本。
- [ ] 按现有所有权清理会话快照，保留必要的 ID、名称与版本审计信息。

### Provider Adapter

- [ ] 内部任务模型增加独立的 Skill 引用字段；保持用户任务、facts 和 Skill 指令的来源可辨识。
- [ ] 用能力描述和版本探测区分原生 Skill、额外目录、文本兼容及不支持。
- [ ] Codex：适配 `skills/list`、额外来源目录和 `turn/start` 的 `skill` 输入项，引用会话快照路径。
- [ ] Copilot：为子进程配置额外 Skill 来源目录；验证 ACP 下显式调用方式，不直接假定交互 CLI 命令等价。
- [ ] DSH：为该运行时配置文件系统 Skill Provider 的 `customSkillDirs`，验证 ACP 下加载与资源访问。
- [ ] 兼容方式：向任务注入选中的 `SKILL.md` 正文并提供可读取的快照资源目录。
- [ ] 避免原生加载与正文注入重复提供同一份指令；不修改用户全局 Provider 配置。
- [ ] 加载失败显式返回失败，不静默移除用户指定的 Skill 继续执行。
- [ ] 验证不同会话、项目及 Provider 之间的配置与快照隔离。

### API、Server 与 Web

- [ ] 在 JSON Schema 中定义执行配置与 Skill 引用，按现有工具生成 Swift/TypeScript 类型。
- [ ] 提供受授权约束的执行配置和 Skill 元数据查询，远程调用只提交 ID。
- [ ] 创建 job/conversation 时支持拟新增的 `profileId`、`skillIds` 字段。
- [ ] Server 校验配置、设备和 Skill 归属，Mac 校验真实路径与执行权限。
- [ ] Mac 保存本地路径和技能文件；Server/Web 仅保存、展示必要 ID、名称、版本和状态。
- [ ] 明确记录有效的 Skill 集合、实际加载方式和版本。
- [ ] 状态区分“已选择”“已提供给 AI”“已观察到读取”；没有读取证据时不能标记已使用。
- [ ] Web 查看会话绑定的 Skill，并显示加载错误。
- [ ] 为新旧 App/Server 增加能力协商与兼容提示，避免新增字段被旧服务端拒绝。

拟新增的调用形式（当前 API 尚不支持）：

```json
{
  "profileId": "invest",
  "provider": "codex",
  "skillIds": ["stock-analysis", "report-writing"],
  "input": { "instructions": "分析本次数据并生成报告" }
}
```

### 验收

- [ ] 不同本地位置的技能可同时登记、搜索、选择。
- [ ] 同名技能可按来源精确选择，实际加载的路径与快照一致。
- [ ] 验证同一 Skill 在 Codex、Copilot、DSH 上的提供、加载及依赖行为。
- [ ] 原始文件修改后，正在运行的会话继续使用原快照，新会话使用新版。
- [ ] 长期对话后续轮次保持已绑定技能；不得因上下文压缩静默失去必要指令。
- [ ] 缺失、越界、失效、依赖不足、旧版本及 Provider 不支持都有明确结果。
- [ ] 普通测试使用假运行时；真实模型探针必须显式开启。
- [ ] 运行 contracts 检查、相关 Server/Mac 测试、Web 构建及 `pnpm check`。

## 第二阶段：来源分发与按需选择

- [ ] 项目上传完整 Skill 包，经授权后由目标 Mac 接收、校验、登记；远程路径不作为 Mac 路径使用。
- [ ] 支持 Git 来源、固定提交版本、更新预览及回退。
- [ ] 由已配置的可用目录提供名称和说明，按任务选择并按需读取全文，限制上下文占用。
- [ ] 提供只允许指定 Skill 的隔离模式，单独控制 Provider 默认来源。
- [ ] 评估通过本地 MCP 提供统一 Skill 检索与资源读取；工具连接独立授权。
- [ ] 评估长期对话技能切换、版本迁移与运行环境依赖管理。

## 官方参考（实施时重新核对版本）

- [Agent Skills 规范](https://agentskills.io/specification)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Copilot CLI Skill 参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [DSH 文件系统 Skill Provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)
