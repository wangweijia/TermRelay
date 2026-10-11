# invest 接入 TermRelay AI 服务 TODO

> 状态：待用户评审；尚未修改 invest 代码。
>
> 范围：本文件只规划 invest 后续接入。TermRelay 实现和使用方式见 [AI_SERVICE_SETUP.md](AI_SERVICE_SETUP.md)，设计见 [AI_SERVICE_DESIGN.md](AI_SERVICE_DESIGN.md)。用户确认后再实施以下改动。

## 1. 配置与适配器

- [ ] 在 invest 配置中增加 Server 局域网地址、TERMRELAY_API_KEY、固定 deviceId 和 profile 映射；密钥只放后端忽略提交的配置，前端不得获取。
- [ ] 新增 TermRelayProvider，适配现有 AnalysisProvider／ResearchProvider；沿用 analyze、complete_json、repair_analysis 业务接口。
- [ ] 实现 targets 检查、创建、轮询、取消和关闭；保留现有模型 Provider 作为明确配置的降级选项。
- [ ] 区分传输重试与业务重提：请求重试使用原幂等键，新分析／新修复使用新键；Key 轮换不改变资源归属。
- [ ] 兼容 usage=null，保留请求次数、耗时和输入哈希预算，不能把未知 Token 记为零。

## 2. 一次性期权推荐

- [ ] 每次推荐构造冻结事实和业务输入哈希，创建独立 job，结果完成后不复用其会话。
- [ ] 多阶段推荐由 invest 明确编排；若阶段独立则分别创建 job，传入必要前序材料。需要多轮共享上下文的研究显式采用 conversation，并在推荐结束后关闭。
- [ ] 保留现有推荐 Schema、证据 ID、策略规则和业务状态校验；TermRelay succeeded 不等同于推荐可用。
- [ ] JSON／Schema 失败时由 invest 显式修复，控制修复次数和总预算，不叠加隐藏修复。
- [ ] 下一次推荐新建资源和幂等键，验证没有前一次推荐上下文污染。

## 3. 一天内长期异常行情分析

- [ ] 按交易日期、研究主题及分析角色保存 conversationId；一次异常分析主题在一天内串行使用同一会话。
- [ ] 每轮提供最新行情时间、快照 ID、新增证据，以及哪些旧事实已被替代；连续性依赖会话记忆，当前判断依赖本轮最新事实。
- [ ] 在 invest 侧串行化同一 conversation 的分析请求；409 busy 时使用业务门控，不无界排队。
- [ ] 收盘／主题结束时显式关闭；次日新建，处理进程重启时遗留的业务记录和未关闭会话。
- [ ] 会话已关闭时通知业务层；经明确业务决策创建新会话并附必要摘要，不自动恢复旧 ID 或静默重跑结果未知的任务。
- [ ] 主分析与独立复核使用不同会话；将有意共享的前序结论与独立判断场景分开。

## 4. 错误、截止时间和记录

- [ ] 统一处理 401／403、device_offline、device_busy、conversation_busy、conversation_closed、invalid_json 和 schema_mismatch。
- [ ] 同时设置业务总截止时间和每轮 deadlineSeconds，轮询超时后发起取消并查询终态，不将取消请求当作停止证明。
- [ ] connection_lost／server_restarted 等结果未知时，记录待核实状态，不自动判断未执行、不自动重复推荐。
- [ ] 记录 jobId／conversationId／turnId、实际模型、业务快照和最终校验结果；保存所需业务结果，不依赖 TermRelay 30 天任务历史长期可用。
- [ ] 保留现有门控、预算、规则降级和数据库写入，不给 Agent 生产数据库访问权。

## 5. 接入验收

- [ ] 首先手动试点一次推荐和同一天至少两轮行情分析，再决定是否切换自动盘中／收盘调用。
- [ ] 网络重试不重复执行；通用 Key 不区分项目，所有持有人共享 AI 资源访问权限，只向可信调用方分发。
- [ ] 一次性推荐隔离；长期分析能使用先前上下文，同时正确替换旧行情。
- [ ] 取消、断线、JSON 错误和模型不可用时原有业务降级仍有效。
- [ ] 最后以真实 Codex／DSH 输出验证结构化质量、推理耗时和上下文容量，用户确认后再调整默认 Provider。
