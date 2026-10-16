# 新增 Workflow 追踪分析方案 - 评审与修订

> 本文件评审 `新增Workflow追踪分析.md`（ChatGPT 产出的 Development Trace & History 设计方案），
> 核对其中所有技术假设与仓库现状（v0.11.2）的事实，纠正不准确表述，补充文档遗漏的约束与边界，
> 并给出修订后的开发优先级建议。
>
> 评审基线：`main` 分支 `f04c2e7`，版本 v0.11.2，`@opencode-ai/plugin` 1.18.27。

## 类头流程图：方案四层边界

```
 本方案的数据流边界

 Workflow 执行（Runtime）
        │
        ├── development: true
        │
        ▼
 Trace Collector（采集）
        │
        ├── Runtime Event 通道：workflow / agent / composite 的开始结束状态重试
        │
        └── OpenCode Session 通道：session.messages() 拉取 ToolPart 全量
              │
              ▼
 Unified Execution History（整理后的执行档案，不可变）
        │
        ├── history.jsonl  机器可读全局时间线
        ├── history.md      人与 LLM 可读整理视图
        └── traces/ + sessions/  原始证据（写入后不修改）
              │
              ▼
 History Analyzer（推论，绑定证据）
        │
        ├── 临时脚本固化机会
        ├── 重复执行识别
        ├── 失败与异常模式
        └── Workflow 架构优化
              │
              ▼
 Optimization Proposals（代码候选，待人工批准）
        │
        └── workflow-optimize Skill 接力：改版 / 验证 / 沉淀经验
```

**核心原则不变**：Trace 是事实，History 是整理后的档案，Analysis 是推论，Optimization 才是代码修改。四层分开。

## 一、评审总体结论

原方案的方向正确、分层清晰、复用现有架构而非另起炉灶，值得执行。但有以下需要修正与补充的点：

| 类别 | 数量 | 说明 |
|------|------|------|
| 已核实正确 | 15 项 | 见下方事实核对表，文档对仓库现状的判断基本准确 |
| 需要纠正 | 4 项 | P0 风险被高估；遗漏第三条执行路径；Composite 身份冲突比文档描述更严重；防递归机制应复用已有 trigger 字段 |
| 需要补充 | 5 项 | ToolPart schema 已含完整 input；output 截断与 7 天保留期；session.messages 分页参数；每个 agent() 独立 session 的采集优势；.gitignore 已覆盖 |

**最重要的一条**：原方案把 P0（验证能否拿到 Agent 内部工具调用过程）视为「整个方案最大的不确定性」。但 OpenCode schema 已明确证明 `ToolPart.state.input` 包含完整的工具入参（write 的文件内容、bash 的命令原文），`state.output` 含截断输出，`metadata.outputPath` 指向磁盘全文。P0 的不确定性从「可行性未知」降级为「运行时实证 + 边界确认」，大幅去风险。

## 二、事实核对表

### 2.1 已核实正确的判断

| 原文档判断 | 仓库证据 | 结论 |
|------|------|------|
| 版本 v0.11.2 | `package.json` version = 0.11.2 | 正确 |
| JournalStore 保存成功调用结果及部分失败 attempt | `journal.ts:55-80` append 只写 hash/result（成功），recordExecution 只写 executions[]（绝不写 hash） | 正确 |
| Journal 不等于完整 Trace | journal 不保留工具调用、临时脚本、完整 prompt（4KB 截断） | 正确，且文档未夸大 |
| recordExecution 最多保留最近 10 条 | `journal.ts:28` EXECUTIONS_CAP = 10 | 正确 |
| WorkflowExecutionRecord 记录父子身份、状态、耗时 | `types/index.ts:42-61` 含 scopePath / startedAt / durationMs / status | 正确 |
| AgentExecutionRecord 保存重试、会话 ID、错误、用量 | `types/index.ts:27-38` 含 attempt / sessionId / error / usage | 正确 |
| OpenCodeSessionAdapter 创建独立 Agent Session | `opencode-session-adapter.ts:122-134` 每次 run() 调 client.session.create | 正确 |
| run-lineage.ts 只记录 agentSessionId 到 rootSessionId，进程内 Map 非持久化 | `run-lineage.ts:22` `const lineage = new Map`，注释「进程内 Map，重启即失」 | 正确 |
| resumeFromRunId 复用原 runId | `workflow.ts:121` `const runId = input.resumeFromRunId ?? run-...` | 正确 |
| CompositeRecord.id 在每个 scope 内从 cmp0 开始 | `workflow-runtime.ts:928` `const id = cmp${scope.compositeSeq++}`，scope 私有计数 | 正确 |
| runWorkflow 出错时直接抛异常 | `workflow.ts:262-284` catch 块写终态快照后 re-throw；`workflow-runtime.ts:297` phaseFailed 终检 throw | 正确 |
| 前台与后台是两条执行路径 | `workflow.ts`（前台）与 `background-runs.ts`（后台）各自调 runWorkflow | 正确 |
| workflow-optimize Skill 已具备版本备份、执行、快照、质量评审、经验回填 | `skills/workflow-optimize/SKILL.md` 全文确认 | 正确 |
| session.messages() API 存在 | `openapi.json:6092` operationId `session.messages` | 正确 |
| 工具输出默认截断 2000 行 / 50KB | `truncate.ts:14-15` MAX_LINES = 2000, MAX_BYTES = 50*1024 | 正确 |

### 2.2 需要纠正的点

#### 纠正 1：P0 风险被高估，可行性已在 schema 层确认

原方案称：

> 整个方案中最大的不确定性，不是怎么调用 Analyzer，而是：能否完整地获取 Agent 内部执行工具的真实过程，尤其是动态生成和执行过的脚本。

**实际证据**（`schema/src/v1/session.ts:259-322`）：

```
ToolStateCompleted = {
  status: "completed",
  input: Record<String, Any>,     <- 完整工具入参
  output: String,                 <- 截断后的输出预览
  title: String,
  metadata: Record<String, Any>,  <- 含 outputPath 指向磁盘全文
  time: { start, end, compacted? },
  attachments?: FilePart[]
}

ToolStateError = {
  status: "error",
  input: Record<String, Any>,     <- 失败时的完整入参
  error: String
}
```

ToolPart（`session.ts:315-322`）：
```
ToolPart = {
  type: "tool",
  callID: String,
  tool: String,         <- 工具名（write / bash / edit / read...）
  state: ToolState      <- 上述四种状态之一
}
```

**结论**：对「临时脚本固化」分析最关键的证据——Agent 用 write 工具写入的脚本内容、用 bash 工具执行的命令原文——都在 `state.input` 中，且是**完整未截断**的（input 是 `Record<String, Any>`，不经过 truncate.ts 的行数/字节限制）。

P0 残留的不确定性收窄为三个具体可测项：
1. 服务端运行时是否真正填充了 `state.input`（schema 允许但需实证服务端处理器）
2. output 截断后全文需读 `metadata.outputPath`（有 7 天保留期，见补充项）
3. session.messages() 是调用时刻的快照，需在 agent 终态后拉取，避免漏收晚到 part

**修订建议**：P0 重新定义为「运行时实证 + 边界确认」，而非「可行性探索」。验收标准见第四节。

#### 纠正 2：遗漏第三条执行路径 ScheduleRuntime

原方案只提到前台（`workflow.ts`）与后台（`background-runs.ts`）两条路径，建议「统一到 RunFinalizer」。

**实际**：仓库还有第三条路径 `src/schedule/runtime.ts`（定时调度）。其链路：

```
ScheduleRuntime.tick()
  -> manager.createRootSession()  创建 fresh 顶层会话
  -> manager.start(...)           复用 BackgroundRunManager.start
  -> onFinished 回调              写 ScheduleRun Record
```

`ScheduleRuntime` 不直接调 `runWorkflow`，而是经 `BackgroundRunManager.start()` 间接执行，且已有 `onFinished` 回调作为终态钩子。

**修订建议**：RunFinalizer 应注入 `BackgroundRunManager.execute()` 的终态路径（completed / failed / aborted 三态统一），这样前台、后台、定时三条路径只需在前台 `workflow.ts` 和后台 `background-runs.ts` 两处接线（定时复用后台路径）。定时路径的 `onFinished` 是现成的 Record 写入点，Development Job 可在此并行触发。

原方案第四节改动表需补充一行：

| 文件 | 改动 |
|------|------|
| `src/schedule/runtime.ts` | 不直接改；其 onFinished 经 BackgroundRunManager 的 Finalizer 间接触发 |

#### 纠正 3：Composite 身份冲突比文档描述更严重——已是当前潜在 Bug

原方案说：「当前部分进度收集代码按 id 查找替换。History 系统要使用复合身份，否则不同子 Workflow 的组合节点可能冲突。」

**实际**：这不只是 History 的未来问题，而是当前进度收集的已有隐患。

证据：
- `workflow-runtime.ts:928`：`const id = cmp${scope.compositeSeq++}`，scope 私有计数，每个子 Workflow 的 compositeSeq 都从 0 起。
- `workflow-runtime.ts:940`：`shared.composites.push(record)` —— 所有 scope 的 CompositeRecord 推入同一个 shared 数组。
- `workflow.ts:238`：`progressComposites.findIndex((c) => c.id === record.id)` —— 只按 id 字符串匹配，不含 scopePath / compositePath。
- `background-runs.ts:208`：同样只按 `c.id === record.id` 匹配。

当两个兄弟子 Workflow（经 parallel() 并发）各执行一个 sequence/fallback/race 时，二者都产生 `cmp0`，推入 shared.composites 后，onCompositeUpdate 更新第二个时会错误命中第一个。

**修订建议**：
1. CompositeRecord 的进度匹配键应改为 `scopePath.join(":") + ":" + compositePath.join(":")`（或直接用 compositePath 全链），而非裸 id。
2. History 系统的复合身份用 `runId + scopePath + compositePath`，与文档建议一致，但应明确这是修当前 Bug 而非仅为 History 预留。
3. 该修正属 P0 范围（否则并行子 Workflow 的组合节点观测数据本身就不可信，Trace 更无法准确）。

#### 纠正 4：防递归机制应复用已有 trigger 字段

原方案建议用 `trigger: "development-optimizer"` 标记 Optimizer Run 防递归，并新增 `isOptimizerRun` 布尔判断。

**实际**：`WorkflowRunOptions.trigger` 已存在且正是此用途（`workflow-runtime.ts:112-117`）：

```typescript
trigger?: {
  type: string          // "manual" / "schedule" / "development-optimizer" ...
  scheduleId?: string
  scheduledAt?: string
}
```

现有代码已把 trigger 写入 run 日志首行（`workflow-runtime.ts:289-294`），且 ScheduleRuntime 已用 `trigger: { type: "schedule" }`。

**修订建议**：Optimizer Run 设 `trigger: { type: "development-optimizer" }`，history.ready 监听器判断 `event.trigger.type !== "development-optimizer"` 即可，无需新增布尔字段。这与现有 Observability 设计一致（需求 26）。

## 三、需要补充的约束与边界

### 补充 1：ToolPart.state.input 是完整未截断的

这是 P0 去风险的关键依据。truncate.ts（`truncate.ts:39` 的 `output()` 函数）只作用于工具的**输出**，不作用于**输入**。所以：
- write 工具的 `state.input.content` = Agent 写入的完整文件内容（含临时脚本全文）
- bash 工具的 `state.input.command` = 执行的完整命令
- edit 工具的 `state.input` = 完整的 oldString / newString

即使 Agent 创建后又删除了临时脚本，write 工具的 input 仍保留了脚本全文。Trace Collector 可据此还原。

### 补充 2：工具输出截断 + 磁盘全文 7 天保留期

`truncate.ts:12` `RETENTION = Duration.days(7)`，截断后的全文写入 TRUNCATION_DIR，`metadata.outputPath` 指向该文件。

**约束**：
- 如果 History 需要工具的完整输出（而非截断预览），必须在 7 天内读取 `metadata.outputPath`。
- 超过 7 天的旧 Run，磁盘全文已被 cleanup 清理，只剩截断预览。History 应在 `manifest.json` 标注采集完整性：`outputIntegrity: "full" | "truncated-only" | "missing"`。
- Agent 临时脚本内容在 input（非 output），不受 7 天保留期影响。所以「脚本固化分析」的核心证据是持久的，但「脚本执行输出」可能过期。

### 补充 3：session.messages() 分页参数

`openapi.json:6120-6136` 显示 session.messages 支持 `limit`（整数）和 `before`（字符串游标）查询参数。

**约束**：长会话（Agent 执行大量工具调用产生很多 message）需分页拉取。不过本仓库的 agent() 每次 `client.session.create` 创建全新 session 并只发一次 prompt，所以每个 agent 的 session 通常只有 1 条 user message + 1 条 assistant message。分页需求低，但应预留分页能力防止长 agent 会话（如 general agent 多轮工具调用产生大量 part）。

### 补充 4：每个 agent() 调用是独立 session，采集无交叉污染

`opencode-session-adapter.ts:122-128`：每次 `run()` 调 `client.session.create({ parentID, title })` 创建新 session。

**优势**：Trace Collector 对某 agent 的 `session.messages(sessionId)` 只返回该 agent 单次 prompt 的消息，不会混入其他 agent 的工具调用。采集粒度天然对齐 agent 粒度，无需额外拆分。

**约束**：session.messages() 拉取的是该 session 的全部消息。由于本仓库一个 session 一次 prompt，实际只取最后一条 assistant message 的 parts 即可还原该 agent 的全部工具调用序列。

### 补充 5：.opencode-workflows/ 已被 gitignore 覆盖

`git check-ignore .opencode-workflows/` 返回命中。原方案提到的「Git 忽略」已无需额外配置——history/ 目录自动被忽略。

## 四、修订后的 P0 验收标准

原方案 P0 验收要求「工具调用记录 / 临时脚本 / 异常执行」三项。基于 schema 已确认的事实，修订为更具体的可测断言：

| 验证项 | 具体断言 | 已知边界 |
|--------|----------|----------|
| 工具入参 | `session.messages(sid)` 返回的 assistant message parts 中，ToolPart 的 `state.input` 包含 write 工具写入的完整脚本内容（逐字节一致） | 无截断，schema 层已确认 |
| 工具命令 | bash 工具的 `state.input.command` 与 Agent 实际执行的命令一致 | 无截断 |
| 工具输出 | `state.output` 为截断预览（超 2000 行或 50KB 被截）；`metadata.outputPath` 指向磁盘全文 | 7 天保留期 |
| 工具状态 | 失败的工具 ToolPart 的 `state.status === "error"`，含 `state.error` 与 `state.input` | schema 已确认 |
| 顺序还原 | parts 数组按生成顺序排列，可还原 Agent 的工具调用时序 | 同一 message 内有序 |
| 中断保留 | Agent 被 abort 后，session.messages() 仍返回已产生的 ToolPart（pending/running/completed/error 混合） | 需实证：abort 后 session 是否保留未完成 part |
| 采集时机 | 在 agent record 到达终态（onAgentUpdate status=ok/failed/aborted）后拉取，parts 已完整 | 过早拉取会漏晚到 part |

P0 只需写一个测试：注入一个会执行 read -> write -> bash -> edit -> bash（其中一次 bash 失败）的 fake agent session，然后验证 session.messages() 能否完整还原这 5 次工具调用的入参与状态。

## 五、修订后的开发优先级

| 阶段 | 范围 | 修订点 |
|------|------|--------|
| P0 | Trace 采集能力运行时实证 | 风险从「未知」降为「实证」；增加 output 7 天保留期与 outputPath 读取边界；增加 abort 后 part 保留验证 |
| P0（附带） | Composite 身份冲突修正 | 新增：修当前已有的 cmpN 跨 scope 冲突 Bug（进度匹配键改用 compositePath 全链） |
| P1 | Trace Store + 父子关联 + History Builder | runAttemptId 区分 resume 轮次；复合身份用 runId+scopePath+compositePath；manifest.json 标注采集完整性 |
| P1（附带） | RunFinalizer 统一接入三路径 | 前台 workflow.ts + 后台 background-runs.ts 两处接线，定时经 onFinished 间接触发 |
| P2 | development 开关 + history.ready + Development Job | 防递归用已有 trigger.type 字段（值为 "development-optimizer"），不新增布尔字段 |
| P3 | Analyzer 四类规则 + 脚本固化验证 + Skill 集成 | 脚本固化分析的证据源是 ToolPart.state.input（持久），输出对比需在 7 天内读 outputPath |

## 六、修订后的代码组织建议

原方案第六节的目录结构基本合理，补充两点：

```
src/
├── trace/
│   ├── collector.ts      // 双通道：Runtime Event + session.messages()
│   ├── store.ts          // JSONL 原始事件，不可变
│   ├── events.ts         // 事件类型定义
│   └── sanitizer.ts      // 脱敏（工具输出可能含敏感内容）
├── history/
│   ├── builder.ts        // 合并执行树 + 全局时间线
│   ├── lineage.ts        // 父子 Run 关联（补充 rootRunId / parentRunId / runAttemptId）
│   └── schema.ts         // manifest / history.jsonl / history.md 的形状定义
├── development/
│   ├── manager.ts        // 持久化任务队列 + createOnce 防重复
│   ├── job-store.ts      // 磁盘持久化（插件重启可恢复）
│   └── optimizer.ts      // 复用 runWorkflow，trigger.type = "development-optimizer"
└── analysis/
    ├── analyzer.ts
    ├── rules/
    │   ├── script-extraction.ts   // 证据源：ToolPart.state.input
    │   ├── duplicate-work.ts
    │   ├── failure-pattern.ts
    │   └── workflow-structure.ts
    └── report.ts
```

补充约束：
1. `trace/collector.ts` 的 session.messages 拉取逻辑放 `OpenCodeSessionAdapter` 扩展方法（adapter 层是唯一允许触碰 SDK 的位置，AGENTS.md 架构约束），TraceCollector 只消费 adapter 返回的结构化结果。
2. `development/optimizer.ts` 复用 `runWorkflow()`，经 `BackgroundRunManager.start()` 执行（非前台），设 `trigger: { type: "development-optimizer" }`。
3. Runtime（`src/runtime/`）禁止 import 上述任何新模块——Trace 采集经 adapter 回调注入，Runtime 只发射事件，不感知 Trace 存在。

## 七、技术决策锁定（修订版）

| 决策项 | 原方案建议 | 修订 |
|--------|------------|------|
| 功能入口 | Workflow 工具参数 development: true | 不变（是 tool 参数，非 DSL 原语参数） |
| 子 Workflow 继承 | 自动继承根 Run 采集策略 | 不变 |
| 数据格式 | JSONL + Markdown | 不变 |
| 触发机制 | history.ready + 持久化队列 | 不变 |
| 优化执行 | 复用 runWorkflow | 不变；经 BackgroundRunManager 后台执行 |
| 防递归 | Optimizer Run 标记 trigger | 复用已有 trigger.type = "development-optimizer"，不新增布尔字段 |
| Composite 身份 | runId + scopePath + compositePath | 提升为 P0：当前进度收集已有 cmpN 冲突 Bug，一并修 |
| RunFinalizer | 前台 + 后台两处统一 | 补充：定时经 onFinished 间接统一，共三路径 |
| 工具输出全文 | 未提及保留期 | 补充：7 天保留期（truncate.ts），超期只剩截断预览 |
| 工具入参 | 强调保留 input 证据 | 补充：input 不截断，是脚本固化分析的核心持久证据 |
| 采集完整性 | manifest 标注 complete/partial/failed | 不变；补充 outputIntegrity 字段区分全文/截断/缺失 |

## 八、引用说明

本评审核对的所有仓库源码位置：

- JournalStore：`src/persistence/journal.ts`
- WorkflowExecutionRecord / AgentExecutionRecord / CompositeRecord：`src/types/index.ts:27-121`
- OpenCodeSessionAdapter：`src/adapters/opencode-session-adapter.ts`
- AgentSessionRunner 接口：`src/agent/session-runner.ts`
- runWorkflow 执行核心：`src/runtime/workflow-runtime.ts`
- 前台工具入口：`src/tools/workflow.ts`
- 后台执行管理：`src/tools/background-runs.ts`
- 定时调度：`src/schedule/runtime.ts`
- 嵌套血统：`src/tools/run-lineage.ts`
- 运行快照：`src/tools/run-snapshot.ts`
- 插件入口：`src/index.ts`
- workflow-optimize Skill：`skills/workflow-optimize/SKILL.md`
- OpenCode SDK session.messages：`thirdparties/opencode/packages/sdk/openapi.json:6089-6202`
- ToolPart schema：`thirdparties/opencode/packages/schema/src/v1/session.ts:259-322`
- 工具输出截断：`thirdparties/opencode/packages/opencode/src/tool/truncate.ts:12-15`
- AGENTS.md 已核实 API 事实：`AGENTS.md`（format 字段、v1 无 storage、无 tool.* 事件、directory 为 query 参数、abort 不级联、输出截断、session.prompt 支持 agent、default export 必带 id、tool 无超时）
