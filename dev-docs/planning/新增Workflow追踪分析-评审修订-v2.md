# 新增 Workflow 追踪分析 - 评审修订 v2

> 本文件基于第二轮评审（ChatGPT 对 v1 的评审）整合修订，形成 v2 需求基线。
> v1 评审了原始方案的技术假设；v2 修正 v1 的 5 个问题，锁定开发优先级。
>
> 评审基线：`main` 分支 `f04c2e7`，版本 v0.11.2，`@opencode-ai/plugin` 1.18.27。

## 类头流程图：修订后的完整闭环

```
 本方案从执行到自动优化的完整生命周期

 Workflow 执行 development true
        |
        v
 Workflow 终态 completed failed aborted
        |
        v
 RunFinalizer 统一入口 前台 后台 定时三路径
        |
        v
 收集 Session Trace 遍历全部 Assistant 消息的全部 ToolPart
        |
        v
 合并父子 History 含 Resume 回放来源关联
        |
        v
 校验采集完整性 full partial failed
        |
        +-------+-------+
        |       |       |
        v       v       v
     可用     部分     失败
        |       |       |
        |       v       v
        |   保留错误   保留错误
        |   和恢复信息  和恢复信息
        v
 History Ready
        |
        v
 创建 Development Job createOnce 幂等
        |
        v
 Optimizer 执行 trigger type development optimizer
 development false originRunId 透传嵌套
        |
        v
 分析报告与优化候选
        |
        v
 等待人工审核应用
```

## 一、v2 总体结论

第二轮评审提出 5 个问题，经仓库源码逐一核实，结论如下：

| 编号 | 问题 | 核实结论 | 处置 |
|------|------|----------|------|
| P0-1 | Fake Agent 测试不能证明真实 Trace 采集 | 有效 | 采纳：P0 拆为 P0-A Mock + P0-B 真实集成 |
| P0-2 | 不能只读取最后一条 Assistant Message | 有效且已用源码证实 | 采纳：采集全部消息的全部 ToolPart |
| P1-1 | Resume 场景缺少 Trace 来源关联 | 有效 | 采纳：新增 TraceProvenance 来源字段 |
| P1-2 | 工具执行历史不等于可恢复的临时脚本 | 部分有效 | 采纳边界，缩减范围为证据充分性标记 |
| P2-1 | trigger.type 防递归还需补一层 | 有效 | 采纳：嵌套 Run 透传 originRunId + development false |

v1 的「只取最后一条 Assistant Message」是明确的错误，源码证据见第二节。

## 二、逐条核实与修正

### 2.1 P0-1：Fake Agent 测试不能证明真实 Trace 采集

**评审判断：有效。**

v1 建议的「注入 fake agent session 验证 read → write → bash → edit → bash」只能验证 Trace Collector 对模拟 ToolPart 的解析逻辑。Fake AgentSessionRunner 不调用 `client.session.prompt()`，更不会调用 `client.session.messages()`，因此无法证明真实 OpenCode 服务端是否填充了 `ToolPart.state.input`。

**v2 修正**：P0 拆为两层：

| 测试 | 目的 | 形式 |
|------|------|------|
| P0-A Mock 单元测试 | 验证 JSON 解析、工具状态识别、事件关联、callID 去重 | node:test + 构造 ToolPart 固定数据 |
| P0-B 真实集成测试 | 验证真实 Session 中 read write bash edit 失败 中止的返回值 | 需真实 OpenCode 服务端运行 |

P0-A 可以立即开始（无外部依赖）。P0-B 需要一个可用的 OpenCode 实例和一个会真实执行工具的 general agent。

P0-B 的三个必须回答的问题（修订自 v1）：

| 验证项 | 断言 |
|--------|------|
| 工具入参 | `session.messages(sid)` 返回的全部 Assistant 消息中，ToolPart 的 `state.input` 含 write 工具完整脚本内容（逐字节一致） |
| 多消息 | 一次 prompt 产生多条 Assistant 消息（每步模型执行一条），全部 ToolPart 分布在各条消息的 parts 中 |
| 中断保留 | Agent 被 abort 后，session.messages() 仍返回已产生的 ToolPart（含 pending running 状态） |

### 2.2 P0-2：不能只读取最后一条 Assistant Message

**评审判断：有效，且已用源码证实。**

v1 声称「一个 Agent Session 只发一次 Prompt，实际只取最后一条 Assistant Message 的 Parts 即可」。这是错误的。

**源码证据**（`thirdparties/opencode/packages/opencode/src/session/prompt.ts:1081-1201`）：

```typescript
// SessionPrompt.run 的 runLoop
while (true) {
  // ...
  step++
  // ...
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),   // 每次迭代生成新消息 ID
    parentID: lastUser.id,
    role: "assistant",
    // ...
  }
  yield* sessions.updateMessage(msg)  // 持久化一条新 Assistant 消息
  // ... 模型调用 + 工具执行 ...
  // hasToolCalls 为 true 且 finish 为 tool-calls 时继续循环
}
```

OpenCode 的 prompt 处理是一个 `while(true)` 循环：模型每生成一轮响应（可能含工具调用），就创建并持久化一条新的 Assistant 消息。工具执行后结果回传模型，模型再生成下一条 Assistant 消息。一次 prompt 的多步工具调用会产生多条 Assistant 消息，每条含若干 ToolPart。

**v2 修正**：采集方案改为遍历全部消息：

```
session.messages(sessionId, { limit, before 分页 })
  -> 全部消息数组
  -> 过滤 role === "assistant"
  -> 遍历每条消息的 parts
  -> 提取 type === "tool" 的 ToolPart
  -> 按 messageId + partId + callID 去重与排序
```

必须保留的身份字段：`messageId`（消息归属）、`partId`（Part 唯一 ID）、`callID`（工具调用逻辑身份，同一调用的 pending→running→completed 多个 part 共享 callID）。

**采集时机**：必须在 agent record 到达终态（onAgentUpdate status 为 ok failed aborted）之后拉取，确保全部 step 的 part 已持久化。过早拉取会漏晚到的 part。

### 2.3 P1-1：Resume 场景缺少 Trace 来源关联

**评审判断：有效。**

v1 增加 `runAttemptId` 区分 Resume 轮次，但未解决回放 agent 的 Trace 来源问题。

**仓库现状**（`workflow-runtime.ts:453-465`）：Resume 时 hash 匹配的 agent 直接从 journal 回放，设置 `record.replayed = true`，返回 `cached.result`。不创建新 session，不调用 LLM。journal entry 的 `sessionId` 指向原始执行轮次的 session。

如果 History Builder 只读取本次 run 的 session.messages()，回放 agent 的 Trace 会缺失——它们没有产生新 session。

**v2 修正**：新增来源关联字段：

```typescript
interface TraceProvenance {
  runAttemptId: string
  executionId: string
  replayed: boolean
  // 回放节点指向原始执行的来源
  sourceRunAttemptId?: string
  sourceExecutionId?: string
  sourceTraceRef?: string  // 原始 Trace 文件路径或 session 引用
}
```

History Builder 需区分三类事件：
1. 本次真实执行：有新 session，采集 session.messages()
2. 从 Journal 回放：无新 session，从原始 runAttempt 的 Trace 文件引用证据
3. 证据缺失：原始 Trace 已过期（超过 7 天保留期），标记 `outputIntegrity: "missing"`

不能把回放的旧 Trace 伪装成本次重新执行，也不能因为本次无新 session 就判定证据缺失。

**实现要点**：回放 agent 的 `record.replayed === true` 且 journal entry 带 `sessionId`（原始 session）。History Builder 据此回溯原始 runAttempt 的 Trace 目录。若原始 Trace 不存在（旧 run 未采集），标记 `evidence: "unavailable"`。

### 2.4 P1-2：工具执行历史不等于可恢复的临时脚本

**评审判断：部分有效。**

评审提出脚本可能经 bash heredoc（`cat > fix.py <<'EOF'`）写入、动态生成、在 worktree 中创建后被清理。

**核实**：

1. bash heredoc 场景：脚本内容在 bash 工具的 `state.input.command` 中，仍被完整捕获（input 不截断）。但解析 heredoc 内容需要分析器支持，比 write 工具的 `state.input.content` 更难提取。
2. worktree 清理：`workflow-runtime.ts:643-645` 在 agent 的 finally 中 `removeWorktree`。等整个 Workflow 完成后读文件系统确实可能无文件可读。但工具 input 仍保留了内容（write 的 content、bash 的 command）。
3. 脚本多次修改：每次 write edit 都产生独立 ToolPart，按 callID 和时间顺序可还原修改历史。

**v2 修正**：采纳证据充分性标记，但缩减 Artifact Provenance 的范围：

- 第一版不做文件系统监听，只从 ToolPart 序列重建脚本生命周期（创建 → 修改 → 执行 → 删除）。
- 对无法可靠重建的脚本（如 heredoc 内嵌复杂生成逻辑），分析报告标记 `evidenceSufficiency: "low"` 并附原因。
- worktree 场景明确：工具 input 是持久证据来源，文件系统不是。Analysis 不依赖文件系统读取临时脚本。

### 2.5 P2-1：trigger.type 防递归还需补一层

**评审判断：有效。**

v1 建议用 `trigger.type = "development-optimizer"` 标记 Optimizer Run。但 Optimizer Agent 内部若调用 `workflow` 工具执行候选验证，该嵌套调用经 `createWorkflowTool`（`workflow.ts:220`）固定设置 `trigger: { type: "manual" }`，会绕过防递归检查。

**核实**（`workflow.ts:209-242`）：前台路径硬编码 `trigger: { type: "manual" }`；后台路径（`background-runs.ts`）由调用方传入，ScheduleRuntime 传 `trigger: { type: "schedule" }`。嵌套 workflow 工具调用一律走前台路径，得到 `trigger.type = "manual"`。

**v2 修正**：增加执行来源上下文，嵌套透传：

```typescript
// Optimizer Run 启动时
{
  trigger: { type: "development-optimizer" },
  development: false,              // Optimizer 自身不开启 development
  originRunId: "run-001"          // 触发本次优化的业务 Run
}
```

嵌套 Run 启动时（workflow 工具被 Optimizer Agent 调用），需读取来源上下文并透传禁止自动优化的约束。实现路径：

- 方案 A：经 `run-lineage.ts` 的进程内 Map 扩展，记录 `agentSessionId -> { originRunId, developmentForbidden: true }`，嵌套 workflow 工具调用时查表继承。
- 方案 B：经 `BackgroundStartInput` 和 `WorkflowRunOptions` 新增可选的 `developmentForbidden?: boolean` 字段，由调用方显式传入。

最终规则：Optimizer 本身及其派生的全部 Workflow，都不能再自动触发 Development Optimizer。只检查当前 Run 的 `trigger.type` 不够。

## 三、history.ready 状态机（新增定义）

v1 提到 `history.ready` 但未定义完成条件。v2 补充状态机：

| 状态 | 进入条件 | 行为 |
|------|----------|------|
| Workflow 终态 | runWorkflow 返回或抛出（completed failed aborted） | 进入 Finalizing |
| Finalizing | RunFinalizer 接管（前台 后台 定时三路径统一） | 收集 Session Trace + 合并父子 History |
| 校验采集完整性 | Trace 归档完成 | 检查 manifest 的 outputIntegrity |
| History Ready | 归档完成（无论 full partial failed） | 触发 Development Job（仅 development true 且 isRootRun） |

三种终态的处理：

| 场景 | 处理 |
|------|------|
| Workflow 成功完成 | 归档完成后自动启动分析 |
| Workflow 执行失败 | 保留部分 History，允许分析失败原因（development 模式下仍触发 Job） |
| Workflow 被手动中止 | 保留部分 History，第一版默认不自动优化（可配） |

对于 Agent 子 Session 内再启动的独立子 Run，根 History 必须知道哪些子 Run 已完成、哪些未完成或失联。不能仅凭根 Session 终态就假设全部证据已到齐。

**实现约束**：`history.ready` 事件需携带 `{ runId, runAttemptId, isRootRun, development, historyPath, completeness, originRunId }`。监听器检查 `development && isRootRun && trigger.type !== "development-optimizer"` 后 `createOnce` 创建 Job。

## 四、Schedule 路径的 development 透传（新增）

v1 确认 ScheduleRuntime 经 BackgroundRunManager 执行，但未提及定时配置如何获得 `development` 参数。

**现状**（`schedule/runtime.ts:141-167`）：`manager.start()` 的 `BackgroundStartInput` 无 `development` 字段。Schedule 配置（`schedule/types.ts`）也无此字段。

若将来希望定时 Workflow 支持 Development 模式，需在两处增加透传：

1. Schedule 配置 JSON 新增 `development?: boolean` 字段。
2. `BackgroundStartInput` 和 `WorkflowRunOptions` 新增 `development` 字段，ScheduleRuntime 从配置透传。

第一版可不实现定时 development（定时任务通常无人值守，自动优化的候选需人工批准，价值有限），但接口预留字段。

## 五、修订后的开发优先级（v2 最终版）

| 阶段 | 范围 | v2 修订点 |
|------|------|------------|
| P0-A | Mock 单元测试 | 验证 ToolPart 解析、callID 去重、多消息遍历——无外部依赖 |
| P0-B | 真实集成测试 | 验证真实 OpenCode 返回的 session.messages 含完整 ToolPart input，含多 Assistant 消息、中断残留 |
| P0 附带 | Composite 身份冲突修正 | 进度匹配键改用 compositePath 全链，独立提交独立测试 |
| P1 | Trace Store + History Builder | 多消息遍历采集；Resume 回放 TraceProvenance 来源关联；runAttemptId；复合身份 runId+scopePath+compositePath；manifest 采集完整性 |
| P1 附带 | RunFinalizer 统一三路径 | 前台 workflow.ts + 后台 background-runs.ts 接线，定时经 onFinished 间接统一 |
| P2 | development 开关 + history.ready + Development Job | history.ready 状态机；Job 持久化 + createOnce 幂等；防递归 trigger.type + originRunId + developmentForbidden 嵌套透传；插件重启恢复 |
| P3 | Analyzer 四类规则 + Skill 集成 | 脚本固化分析证据源为 ToolPart.state.input（持久），输出对比需 7 天内读 outputPath；证据充分性标记 |

## 六、端到端验收标准

执行真实 Workflow：

```javascript
workflow({
  scriptPath: "./feature-development.js",
  development: true
})
```

业务 Workflow 包含：两个原生子 Workflow、一个嵌套工具调用 Workflow、并行 Agent、脚本生成、一次失败重试。

运行完成后必须自动产出：

```
.opencode-workflows/
└── history/
    └── run-001/
        ├── manifest.json          // 含采集完整性 outputIntegrity
        ├── history.jsonl          // 全局时间线（含回放 agent 的来源引用）
        ├── history.md             // 人可读整理视图
        └── analysis/
            ├── report.md          // 分析报告（数字来自真实 Trace）
            └── proposals.json     // 优化候选（绑定证据引用）
```

并证明：
1. 没有人为再次调用工具，插件自动创建并执行了独立的 Optimizer Job。
2. Optimizer Job 结束后不再触发新一轮优化（防递归生效）。
3. 优化 Job 的失败不改变已成功业务 Workflow 的状态。

## 七、技术决策锁定（v2 最终版）

| 决策项 | v1 | v2 修订 |
|--------|-----|---------|
| 功能入口 | Workflow 工具参数 development true | 不变 |
| 采集粒度 | 取最后一条 Assistant Message | 改为遍历全部消息全部 ToolPart |
| P0 测试 | 单一 fake 测试 | 拆为 P0-A Mock + P0-B 真实集成 |
| Resume Trace | 仅 runAttemptId | 新增 TraceProvenance 来源关联 |
| 脚本还原 | 仅 ToolPart.state.input | 补充证据充分性标记；不依赖文件系统 |
| 防递归 | trigger.type 单层 | trigger.type + originRunId + developmentForbidden 嵌套透传 |
| history.ready | 未定义状态机 | 定义终态 → Finalizing → 校验 → Ready 状态机 |
| Composite 身份 | P0 附带修正 | 不变（提升为 P0 附带） |
| RunFinalizer | 前台 + 后台 | 补充定时经 onFinished 间接统一 |
| 工具输出全文 | 7 天保留期 | 不变；manifest 标 outputIntegrity |
| Schedule development | 未提及 | 接口预留字段，第一版不实现 |
| 自动改写原 Workflow | 第一版禁止 | 不变 |

## 八、引用说明

本修订核对的仓库源码位置：

- prompt 循环与多 Assistant 消息：`thirdparties/opencode/packages/opencode/src/session/prompt.ts:1081-1201`
- session.messages 实现（分页拉取）：`thirdparties/opencode/packages/opencode/src/session/session.ts:828-851`
- ToolPart 与 ToolState schema：`thirdparties/opencode/packages/schema/src/v1/session.ts:259-322`
- 工具输出截断与保留期：`thirdparties/opencode/packages/opencode/src/tool/truncate.ts:12-15`
- Resume 回放逻辑：`src/runtime/workflow-runtime.ts:453-465`
- worktree 清理：`src/runtime/workflow-runtime.ts:643-645`
- 前台 workflow 工具 trigger：`src/tools/workflow.ts:209-242`
- 后台执行管理：`src/tools/background-runs.ts:132-289`
- 定时调度：`src/schedule/runtime.ts:99-181`
- 嵌套血统：`src/tools/run-lineage.ts`
- JournalStore：`src/persistence/journal.ts`
- 类型定义：`src/types/index.ts:27-172`
- Composite 节点生成：`src/runtime/workflow-runtime.ts:920-954`
- OpenCodeSessionAdapter：`src/adapters/opencode-session-adapter.ts`
- AgentSessionRunner 接口：`src/agent/session-runner.ts`
- 插件入口：`src/index.ts`
- workflow-optimize Skill：`skills/workflow-optimize/SKILL.md`
- v1 评审：`dev-docs/planning/新增Workflow追踪分析-评审修订-v1.md`
- 原始方案：`dev-docs/planning/新增Workflow追踪分析.md`
