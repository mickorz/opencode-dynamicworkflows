# P2 执行文档 - development 开关 + history.ready + Development Job

> 本文件是 Development Trace & History 功能 P2 阶段的详细执行计划。
> 基线：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`，P0/P1 已完成并验证通过。
>
> P2 目标：业务 Workflow 执行 `development: true` 后，自动创建 Optimizer Job 分析执行历史，
> 产出 `analysis/report.md` + `analysis/proposals.json`，且防递归、失败不阻断业务 Run。
>
> P2 不实现 Analyzer 四类规则与 Skill 集成（P3 范围）。

## 类头流程图：P2 闭环

```
 P2 从执行到自动优化的完整生命周期

 Workflow 执行 development true
        |
        v
 Workflow 终态 completed failed aborted
        |
        v
 RunFinalizer 统一入口 P1 已做
   采集 Trace 构建 History
        |
        v
 history ready 检查
   development true 且 isRootRun
   且 trigger type 不是 development optimizer
        |
    +---+---+
    |       |
    v       v
  满足    不满足
    |       |
    v       v
 创建 Job  跳过
 createOnce 幂等
    |
    v
 Optimizer 后台执行
   trigger type development optimizer
   development false
   developmentForbidden true
   originRunId 透传
    |
    v
 分析报告与优化候选
   analysis report md
   analysis proposals json
    |
    v
 等待人工审核应用
```

## 一、P2 范围与交付物

| 子项 | 内容 | 依赖 |
|------|------|------|
| development 开关 | workflow 工具参数 + 透传到 Finalizer | P1 RunFinalizer |
| history.ready 触发 | Finalizer 完成后检查条件，触发 Job | P1 FinalizerResult |
| DevelopmentJobManager | createOnce 幂等 + 持久化 + 重启恢复 | BackgroundRunManager |
| Optimizer 脚本 | 内置分析 Workflow 脚本，读 History 产出报告 | P1 TraceStore + HistoryBuilder |
| 防递归 | developmentForbidden 透传 + lineage 查表 | run-lineage.ts |
| 插件重启恢复 | 启动时检查未完成 Job，标记失败 | DevelopmentJobManager |

P2 完成后，执行 `workflow({ scriptPath, development: true })` 会自动产出 `history/<runId>/analysis/` 目录。

## 二、模块结构

```
src/
├── development/
│   ├── job-manager.ts          # P2 新增：DevelopmentJobManager
│   ├── optimizer-script.ts     # P2 新增：内置 Optimizer 脚本（字符串常量）
│   └── types.ts                # P2 新增：DevJob / DevJobStatus 类型
├── tools/
│   ├── workflow.ts             # P2 改动：加 development 参数 + 防递归 + 触发 Job
│   ├── background-runs.ts      # P2 改动：BackgroundStartInput 加 development + developmentForbidden
│   └── run-finalizer.ts        # P2 改动：FinalizerInput 加 development + isRootRun
├── runtime/
│   └── workflow-runtime.ts     # P2 改动：WorkflowRunOptions 加 development（透传）
├── tools/
│   └── run-lineage.ts          # P2 改动：加 developmentForbidden 查表
└── index.ts                    # P2 改动：创建 DevelopmentJobManager + 启动恢复
```

架构约束（AGENTS.md）：
- `src/development/` 禁止 import `@opencode-ai/plugin` / `@opencode-ai/sdk`——宿主无关
- JobManager 需创建后台 run，经依赖注入接收 `BackgroundRunManager` + `ClientLike`
- `src/tools/run-lineage.ts` 扩展 developmentForbidden Map（进程内，不落盘）

代码风格约束（CLAUDE.md）：
- **禁止使用 console.log / console.error / console.warn**——错误通过返回值、metadata 或 throw 暴露
- 注释与 Log 用中文，代码标识符用英文
- 禁止 Emoji

## 三、development 开关

### 3.1 workflow 工具参数

**改动文件：`src/tools/workflow.ts`**

工具 args 新增 `development`：

```typescript
development: tool.schema.boolean().optional().describe(
  "开启 Development 模式：Workflow 完成后自动创建 Optimizer Job 分析执行历史，产出 analysis/report.md 与 proposals.json。Optimizer Job 自身不递归触发。缺省 false。",
),
```

### 3.2 类型透传

**改动文件：`src/runtime/workflow-runtime.ts`**

`WorkflowRunOptions` 新增：

```typescript
/** Development 模式：Run 完成后自动触发 Optimizer 分析 */
development?: boolean
/** 防递归：由 Optimizer Run 透传，禁止本 Run 再触发 Optimizer */
developmentForbidden?: boolean
```

**改动文件：`src/tools/background-runs.ts`**

`BackgroundStartInput` 新增：

```typescript
/** Development 模式（手动调用 / Optimizer 调用时透传） */
development?: boolean
/** 防递归标记（Optimizer Run 设为 true，禁止嵌套 Run 再触发） */
developmentForbidden?: boolean
```

**改动文件：`src/tools/run-finalizer.ts`**

`FinalizerInput` 新增：

```typescript
/** 是否开启 Development 模式 */
development?: boolean
/** 是否为根 Run（非嵌套在另一 Workflow Run 内） */
isRootRun?: boolean
```

### 3.3 前台路径透传

**改动文件：`src/tools/workflow.ts`**

在 `execute` 中：

```typescript
// 防递归：developmentForbidden 时强制关闭 development
const effectiveDevelopment = input.development && !developmentForbidden
```

`developmentForbidden` 来源：查 `run-lineage.ts`（见第六节）。

传给 `runWorkflow`：

```typescript
const result = await runWorkflow(script, {
  // ... 现有参数 ...
  development: effectiveDevelopment,
  developmentForbidden,
})
```

传给 `finalizeRun`：

```typescript
await finalizeRun({
  // ... 现有参数 ...
  development: effectiveDevelopment,
  isRootRun: rootSessionId === context.sessionID,
})
```

### 3.4 后台路径透传

**改动文件：`src/tools/background-runs.ts`**

`execute` 方法中传给 `runWorkflow`：

```typescript
const result = await runWorkflow(input.script, {
  // ... 现有参数 ...
  development: input.development,
  developmentForbidden: input.developmentForbidden,
})
```

传给 `finalizeRun`：

```typescript
await finalizeRun({
  // ... 现有参数 ...
  development: input.development,
  isRootRun: true, // 后台 run 总是根 Run
})
```

### 3.5 Schedule 路径

**改动文件：`src/schedule/types.ts`**

`Schedule` 新增（接口预留，第一版不实现定时 development）：

```typescript
/** Development 模式（定时任务通常无人值守，第一版不自动优化，接口预留） */
development?: boolean
```

ScheduleRuntime 透传 `input.development` 到 `BackgroundStartInput`。

## 四、history.ready 触发

### 4.1 状态机定义

| 状态 | 进入条件 | 行为 |
|------|----------|------|
| Workflow 终态 | runWorkflow 返回或抛出 | 进入 Finalizing |
| Finalizing | RunFinalizer 接管（P1 已做） | 采集 Trace + 构建 History |
| History Ready | finalizeRun 返回（不论 completeness） | 检查 development && isRootRun && trigger.type !== "development-optimizer" |

### 4.2 触发逻辑

**改动文件：`src/tools/workflow.ts`**（前台路径 finally 块）

```typescript
} finally {
  clearInterval(heartbeat)
  context.abort.removeEventListener("abort", onAbort)
  unregisterAgentSessions(registeredSessions)
  // P1: Trace 采集与 History 构建
  let finalizerResult: FinalizerResult | undefined
  try {
    finalizerResult = await finalizeRun({
      // ... 现有参数 ...
      development: effectiveDevelopment,
      isRootRun: rootSessionId === context.sessionID,
    })
  } catch {
    // 采集失败不阻断
  }
  // P2: history.ready -> 创建 Development Job
  if (finalizerResult && effectiveDevelopment && rootSessionId === context.sessionID) {
    try {
      devJobManager.createOnce({
        runId,
        originRunId: runId,
        directory: context.directory,
        historyPath: finalizerResult.historyPath,
        client: ctx.client,
        parentSessionId: context.sessionID,
        rootSessionId,
      })
    } catch {
      // Job 创建失败不阻断 run 终态
    }
  }
}
```

**改动文件：`src/tools/background-runs.ts`**（后台路径 finally 块）

```typescript
// P2: history.ready -> 创建 Development Job
if (finalizerResult && input.development && !input.developmentForbidden) {
  try {
    devJobManager.createOnce({
      runId: info.runId,
      originRunId: info.runId,
      directory: deps.directory,
      historyPath: finalizerResult.historyPath,
      client: deps.client,
      parentSessionId: deps.parentSessionId,
      rootSessionId,
    })
  } catch {
    // Job 创建失败不阻断
  }
}
```

**关键条件**：
- `effectiveDevelopment` / `input.development`：用户显式开启
- `rootSessionId === context.sessionID`（前台）或 `!input.developmentForbidden`（后台）：是根 Run
- Optimizer Run 自身 `development: false`，所以 `effectiveDevelopment` 为 false，不会触发

## 五、DevelopmentJobManager

### 5.1 类型定义

**新建文件：`src/development/types.ts`**

```typescript
/** Development Job 的状态 */
export type DevJobStatus = "pending" | "running" | "completed" | "failed"

/** 单个 Development Job 记录 */
export interface DevJob {
  /** 业务 Run 的 runId（幂等键） */
  runId: string
  /** 触发本次优化的业务 Run ID */
  originRunId: string
  /** Optimizer Run 的 runId（BackgroundRunManager 分配） */
  optimizerRunId?: string
  status: DevJobStatus
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** 失败原因 */
  error?: string
  /** History 目录路径 */
  historyPath: string
}

/** 持久化文件形状（.opencode-workflows/development/jobs.json） */
export interface DevJobFile {
  version: 1
  jobs: DevJob[]
}
```

### 5.2 JobManager 实现

**新建文件：`src/development/job-manager.ts`**

```typescript
/**
 * DevelopmentJobManager —— Development Job 生命周期管理（P2）
 *
 * 职责：
 *  - createOnce：幂等创建 Optimizer Job（同一 runId 只创建一次）
 *  - 持久化到 .opencode-workflows/development/jobs.json
 *  - 插件重启恢复：标记 running 为 failed，重试 pending
 *  - Optimizer Run 的 trigger.type = "development-optimizer"
 *  - Optimizer Run 的 development = false, developmentForbidden = true
 *
 * 约束：
 *  - Job 创建失败不阻断业务 Run 终态
 *  - Optimizer Run 的失败不改变已成功业务 Workflow 的状态
 *  - 不使用 console.log/error（CLAUDE.md 约束）
 */

import fs from "node:fs"
import path from "node:path"
import type { ClientLike } from "../adapters/opencode-session-adapter.js"
import type { BackgroundRunManager } from "../tools/background-runs.js"
import { OPTIMIZER_SCRIPT } from "./optimizer-script.js"
import type { DevJob, DevJobFile } from "./types.js"

const DEV_DIR = path.join(".opencode-workflows", "development")
const JOBS_FILE = "jobs.json"

export interface CreateOnceInput {
  runId: string
  originRunId: string
  directory: string
  historyPath: string
  client: ClientLike
  parentSessionId: string
  rootSessionId: string
}

export interface DevJobManagerOptions {
  background: BackgroundRunManager
}

export class DevJobManager {
  private readonly background: BackgroundRunManager
  private jobs: Map<string, DevJob> = new Map()
  private readonly baseDir: string

  constructor(options: DevJobManagerOptions) {
    this.background = options.background
    // baseDir 在 load 时按项目目录设置
    this.baseDir = ""
  }

  /** 启动时加载持久化 Job 状态并恢复 */
  load(directory: string): void {
    const file = path.join(directory, DEV_DIR, JOBS_FILE)
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DevJobFile
      for (const job of raw.jobs ?? []) {
        // 恢复：running -> failed（服务端被杀），pending -> 重试
        if (job.status === "running") {
          job.status = "failed"
          job.error = "插件重启时被中断"
          job.endedAt = Date.now()
        }
        this.jobs.set(job.runId, job)
      }
      this.persist(directory)
      // 重试 pending Job
      for (const job of this.jobs.values()) {
        if (job.status === "pending") {
          this.startOptimizer(job, directory)
        }
      }
    } catch {
      // 文件不存在或解析失败：首次启动，无历史 Job
    }
  }

  /** 幂等创建 Optimizer Job */
  createOnce(input: CreateOnceInput): DevJob | undefined {
    // 幂等检查
    const existing = this.jobs.get(input.runId)
    if (existing) return existing

    const job: DevJob = {
      runId: input.runId,
      originRunId: input.originRunId,
      status: "pending",
      createdAt: Date.now(),
      historyPath: input.historyPath,
    }
    this.jobs.set(input.runId, job)
    this.persist(input.directory)

    // 立即启动 Optimizer Run
    this.startOptimizer(job, input.directory)

    return job
  }

  /** 启动 Optimizer 后台 Run */
  private startOptimizer(job: DevJob, directory: string): void {
    try {
      const optimizerRunId = this.background.start(
        {
          client: /* 需注入 */,
          parentSessionId: /* 需注入 */,
          directory,
          rootSessionId: /* 需注入 */,
        },
        {
          script: OPTIMIZER_SCRIPT,
          args: {
            originRunId: job.originRunId,
            historyPath: job.historyPath,
          },
          development: false,
          developmentForbidden: true,
          trigger: { type: "development-optimizer" },
          onFinished: (info) => {
            this.onOptimizerFinished(job.runId, directory, info.status, info.error)
          },
        },
      )
      job.optimizerRunId = optimizerRunId
      job.status = "running"
      job.startedAt = Date.now()
      this.persist(directory)
    } catch (e) {
      job.status = "failed"
      job.error = e instanceof Error ? e.message : String(e)
      job.endedAt = Date.now()
      this.persist(directory)
    }
  }

  /** Optimizer Run 完成回调 */
  private onOptimizerFinished(
    runId: string,
    directory: string,
    status: string,
    error?: string,
  ): void {
    const job = this.jobs.get(runId)
    if (!job) return
    job.status = status === "completed" ? "completed" : "failed"
    if (error) job.error = error
    job.endedAt = Date.now()
    this.persist(directory)
  }

  /** 查询全部 Job（workflow_control 或调试用） */
  list(): DevJob[] {
    return Array.from(this.jobs.values())
  }

  /** 持久化到磁盘 */
  private persist(directory: string): void {
    try {
      const dir = path.join(directory, DEV_DIR)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, JOBS_FILE)
      const data: DevJobFile = {
        version: 1,
        jobs: Array.from(this.jobs.values()),
      }
      const tmp = `${file}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
        try { fs.renameSync(tmp, file) } catch { fs.rmSync(file, { force: true }); fs.renameSync(tmp, file) }
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
      }
    } catch {
      // 落盘失败不阻断
    }
  }
}
```

**注意**：`startOptimizer` 中的 `client`、`parentSessionId`、`rootSessionId` 需从 `CreateOnceInput` 传入。上面的代码骨架中标注了 `需注入` 的位置。

### 5.3 插件入口接线

**改动文件：`src/index.ts`**

```typescript
import { DevJobManager } from "./development/job-manager.js"

export const DynamicWorkflowPlugin: Plugin = async (input) => {
  const background = new BackgroundRunManager()
  const devJobManager = new DevJobManager({ background })
  // 启动恢复：加载历史 Job，标记中断的 running 为 failed
  devJobManager.load(input.directory)

  const scheduler = new ScheduleRuntime({
    client: input.client,
    directory: input.directory,
    manager: background,
  })
  scheduler.start()

  return {
    tool: {
      workflow: createWorkflowTool(input, background, devJobManager),
      // ... 其他工具 ...
    },
  }
}
```

`createWorkflowTool` 签名改为接收 `devJobManager`：

```typescript
export function createWorkflowTool(
  ctx: PluginInput,
  background: BackgroundRunManager,
  devJobManager: DevJobManager,
) { ... }
```

## 六、防递归

### 6.1 问题

Optimizer Agent 内部若调用 `workflow` 工具，该调用经 `createWorkflowTool` 的前台路径硬编码 `trigger: { type: "manual" }`，绕过 `trigger.type !== "development-optimizer"` 检查。

### 6.2 方案 B（v2 采纳）：显式字段透传 + lineage 查表

**改动文件：`src/tools/run-lineage.ts`**

新增 developmentForbidden Map：

```typescript
// 进程内 Map：agentSessionId -> developmentForbidden
// Optimizer Run 的 agent 子会话注册时设为 true
// 嵌套 workflow 工具调用时查表继承
const developmentForbiddenSessions = new Set<string>()

export function registerDevelopmentForbidden(sessionId: string): void {
  developmentForbiddenSessions.add(sessionId)
}

export function lookupDevelopmentForbidden(sessionId: string): boolean {
  // 沿血统链向上查：当前会话或其祖先会话有标记则继承
  let current: string | undefined = sessionId
  while (current) {
    if (developmentForbiddenSessions.has(current)) return true
    current = lineageMap.get(current)?.rootSessionId
  }
  return false
}
```

**改动文件：`src/tools/workflow.ts`**

在 `execute` 开头检查 developmentForbidden：

```typescript
const developmentForbidden = lookupDevelopmentForbidden(context.sessionID)
const effectiveDevelopment = input.development && !developmentForbidden
```

在 `onAgentUpdate` 中注册 developmentForbidden（Optimizer Run 传入时）：

```typescript
onAgentUpdate: (record) => {
  // ... 现有逻辑 ...
  if (record.sessionId) {
    registeredSessions.add(record.sessionId)
    registerAgentSession(record.sessionId, rootSessionId)
    // P2: Optimizer Run 的 agent 子会话标记 developmentForbidden
    if (developmentForbidden) {
      registerDevelopmentForbidden(record.sessionId)
    }
  }
}
```

### 6.3 最终防递归规则

| 检查点 | 条件 | 行为 |
|--------|------|------|
| Job 创建 | `effectiveDevelopment && isRootRun && trigger.type !== "development-optimizer"` | 创建 Job |
| Optimizer Run | `development: false, developmentForbidden: true` | 不会触发新 Job |
| 嵌套 workflow 调用 | lineage 查表 `developmentForbidden === true` | 强制 `development = false` |

## 七、Optimizer 脚本

**新建文件：`src/development/optimizer-script.ts`**

内置分析 Workflow 脚本（字符串常量），由 JobManager 传给 `background.start()`。

```typescript
/**
 * Optimizer 内置脚本（P2 第一版）
 *
 * 分析维度（P3 扩展为四类规则）：
 *  1. 读取 History（manifest + history.md）
 *  2. 分析执行模式（重复操作、失败重试、顺序依赖、耗时分布）
 *  3. 生成报告（report.md + proposals.json）
 *
 * args 透传：{ originRunId, historyPath }
 */

export const OPTIMIZER_SCRIPT = `export const meta = {
  name: "development_optimizer",
  description: "自动分析 Workflow 执行历史",
  phases: [
    { title: "读取历史" },
    { title: "分析模式" },
    { title: "生成报告" },
  ],
}

const historyPath = args.historyPath
const originRunId = args.originRunId

phase("读取历史")
const manifest = await agent(
  "用 read 工具读取 " + historyPath + "/manifest.json，报告 completeness、sessions 数量、每个 session 的工具调用数。一句话总结。",
  { agentType: "general", label: "历史读取" },
)

phase("分析模式")
const analysis = await agent(
  "用 read 工具读取 " + historyPath + "/history.md，分析工具调用序列，识别以下模式：\\n" +
    "1. 重复操作（如多次读取同一文件）\\n" +
    "2. 失败后重试（分析失败原因）\\n" +
    "3. 顺序依赖（前一步输出是后一步输入）\\n" +
    "4. 耗时分布（哪些步骤最慢）\\n" +
    "用 JSON 格式输出分析结果。",
  { agentType: "general", label: "模式分析" },
)

phase("生成报告")
const report = await agent(
  "基于上述分析，用 write 工具在 " + historyPath + "/analysis/ 目录下创建两个文件：\\n" +
    "1. report.md：人可读的分析报告，含执行摘要、工具调用统计、发现的问题、优化建议\\n" +
    "2. proposals.json：优化候选列表，每个候选含 title、description、evidence 字段\\n" +
    "evidence 字段引用 history.jsonl 中的具体事件（ts + tool + agentLabel）。\\n" +
    "创建完成后报告文件路径。",
  { agentType: "general", label: "报告生成" },
)

return { originRunId, manifest, analysis, report }
`
```

## 八、测试计划

### 8.1 单元测试

**新建文件：`tests/dev-job-manager.test.ts`**

| 用例 | 验证点 |
|------|--------|
| createOnce 幂等 | 同一 runId 调两次，只创建一个 Job |
| Job 状态流转 pending -> running | startOptimizer 后状态变更 |
| onFinished 回调 | Optimizer 完成后 Job 标 completed |
| Optimizer 失败 | Job 标 failed + error 字段 |
| 重启恢复 running -> failed | load 时 running 状态标记为 failed |
| 重启恢复 pending -> 重试 | load 时 pending 状态重新启动 |
| persist 读写 roundtrip | 文件格式正确，能读回 |
| 落盘失败不抛错 | 只读目录降级 |

### 8.2 防递归测试

**新建文件：`tests/development-forbidden.test.ts`**

| 用例 | 验证点 |
|------|--------|
| developmentForbidden 时 development 被强制关闭 | effectiveDevelopment = false |
| lineage 查表：祖先有标记则继承 | 嵌套会话查到 forbidden |
| lineage 查表：无标记返回 false | 正常 run 不受影响 |

### 8.3 联调验证

#### 8.3.1 脚本目录结构

`dev-examples/development-trace/scripts/` 按阶段归类：

```
scripts/
├── p0/                              ← P0 脚本（Trace 采集验证）
│   ├── trace-verify.js              P0 主验证：read→write→bash
│   ├── composite-verify.js          P0 并行兄弟子 Workflow
│   ├── child-seq.js                 P0 composite 的子 Workflow
│   └── verify-trace-collection.ts   P0 SDK 验证 session.messages
├── p1/                              ← P1 脚本（History 落盘验证）
│   ├── p1-history-verify.js        P1 主验证：多 Agent + 子 Workflow
│   ├── p1-child.js                  P1 子 Workflow
│   └── verify-p1-history.ts         P1 History 落盘验证
└── p2/                              ← P2 脚本（Development Job 验证）
    ├── p2-dev-verify.js             P2 主验证：development:true
    ├── p2-child.js                  P2 子 Workflow
    └── verify-p2-dev.ts             P2 Development Job 与分析报告验证
```

#### 8.3.2 P2 测试脚本说明

**p2-dev-verify.js** — P2 主验证 Workflow

覆盖场景：
- 4 阶段（phase），3 个 Agent 各用不同工具（read / write / bash）
- 1 个子 Workflow（验证 Optimizer 能解析执行树）
- `development: true`（验证 Optimizer 自动触发）

执行方式：
```javascript
workflow({ scriptPath: "./scripts/p2/p2-dev-verify.js", development: true, background: false })
```

**p2-child.js** — P2 子 Workflow

被 p2-dev-verify.js 调用，Agent 读取 tui.json，验证 Optimizer 能解析子 Workflow 层级。

**verify-p2-dev.ts** — P2 落盘验证脚本

验证项：
- `development/jobs.json` 存在且 Job status=completed
- createOnce 幂等（同一 runId 只有 1 个 Job）
- 防递归（Optimizer Run 无新 Job）
- `analysis/report.md` 存在且非空
- `analysis/proposals.json` 存在且含 proposals 数组
- P1 History 完好性不回归（manifest/history.jsonl/history.md 仍在）

执行方式：
```bash
npx tsx scripts/p2/verify-p2-dev.ts <runId>
```

#### 8.3.3 联调步骤

在 `dev-examples/development-trace/` 目录：

1. 编译插件：`npm run build`（项目根目录）
2. 启动 opencode
3. 执行 P2 Workflow：
   ```javascript
   workflow({ scriptPath: "./scripts/p2/p2-dev-verify.js", development: true, background: false })
   ```
4. 拿到 runId 后验证：
   ```bash
   npx tsx scripts/p2/verify-p2-dev.ts <runId>
   ```

验证清单：
1. 业务 Workflow 正常完成（4 阶段全成功）
2. `development/jobs.json` 存在且 Job 状态为 completed
3. `history/<runId>/analysis/report.md` 存在且非空
4. `history/<runId>/analysis/proposals.json` 存在且含 proposals 数组
5. Optimizer Run 不再触发新 Job（防递归）
6. P1 History 完好（manifest.json / history.jsonl / history.md 仍在）

## 九、验收标准

| 编号 | 验收项 | 验证方式 |
|------|--------|----------|
| V-12 | development:true 的 Run 完成后自动创建 Job | 联调验证 |
| V-13 | Job 状态流转 pending -> running -> completed | 单元测试 + 联调 |
| V-14 | analysis/report.md 存在且非空 | 联调验证 |
| V-15 | analysis/proposals.json 存在且含 proposals | 联调验证 |
| V-16 | Optimizer Run 不再触发新 Job（防递归） | 单元测试 + 联调 |
| V-17 | developmentForbidden 时 development 被强制关闭 | 单元测试 |
| V-18 | Job 创建失败不阻断业务 Run | 单元测试 |
| V-19 | 插件重启后 running Job 标记为 failed | 单元测试 |
| V-20 | createOnce 幂等：同一 runId 只创建一次 | 单元测试 |
| V-21 | typecheck + npm test 全量不回归 | CI |

## 十、执行顺序

```
第一步  类型定义
        新建 src/development/types.ts
          |
          v
第二步  Optimizer 脚本
        新建 src/development/optimizer-script.ts
          |
          v
第三步  防递归扩展
        改 src/tools/run-lineage.ts（加 developmentForbidden Map）
        新建 tests/development-forbidden.test.ts
        npm run typecheck && npx tsx --test tests/development-forbidden.test.ts
          |
          v
第四步  DevelopmentJobManager
        新建 src/development/job-manager.ts
        新建 tests/dev-job-manager.test.ts
        npm run typecheck && npx tsx --test tests/dev-job-manager.test.ts
          |
          v
第五步  透传改动
        改 src/tools/workflow.ts（加 development 参数 + 防递归 + 触发 Job）
        改 src/tools/background-runs.ts（BackgroundStartInput 加字段 + 触发 Job）
        改 src/tools/run-finalizer.ts（FinalizerInput 加 development + isRootRun）
        改 src/runtime/workflow-runtime.ts（WorkflowRunOptions 加 development）
        改 src/schedule/types.ts（Schedule 加 development 预留）
        npm run typecheck
          |
          v
第六步  插件入口接线
        改 src/index.ts（创建 DevJobManager + 启动恢复 + 传入 createWorkflowTool）
        npm run typecheck
          |
          v
第七步  全量验证
        npm run typecheck && npm test
        npm run build
        联调验证（dev-examples/development-trace）
```

## 十一、风险与降级方案

| 风险 | 影响 | 降级 |
|------|------|------|
| Optimizer Agent 执行超时 | Job 卡在 running | BackgroundRunManager 无超时；重启恢复标记 failed |
| Optimizer Agent 调用 workflow 工具 | 防递归需生效 | lineage 查表 + developmentForbidden 透传 |
| jobs.json 损坏 | Job 状态丢失 | 解析失败时静默返回空列表（同 JournalStore 范式） |
| analysis/ 目录已存在 | 覆写旧报告 | write 工具原生覆写行为，不额外处理 |
| Optimizer 产出的 proposals.json 格式错误 | 后续消费失败 | P3 阶段加 schema 校验；P2 仅保证文件存在 |

## 十二、引用说明

本执行文档核对的仓库源码位置：

- P1 RunFinalizer（触发点）：`src/tools/run-finalizer.ts`
- P1 TraceStore（History 目录）：`src/trace/store.ts`
- 前台 finally 块（接线点）：`src/tools/workflow.ts:298-322`
- 后台 finally 块（接线点）：`src/tools/background-runs.ts:284-310`
- BackgroundStartInput（扩展点）：`src/tools/background-runs.ts:65-79`
- WorkflowRunOptions（扩展点）：`src/runtime/workflow-runtime.ts:82-121`
- run-lineage.ts（防递归扩展点）：`src/tools/run-lineage.ts`
- 插件入口（接线点）：`src/index.ts:24-40`
- Schedule 类型（预留字段）：`src/schedule/types.ts:13-29`
- v2 评审修订（P2 范围定义）：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`
- P1 执行文档（前置阶段）：`dev-docs/planning/新增Workflow追踪分析-P1执行文档.md`
- P0 执行文档（参考格式）：`dev-docs/planning/新增Workflow追踪分析-P0执行文档.md`
