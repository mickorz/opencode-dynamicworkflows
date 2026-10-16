# P1 执行文档 - Trace Store + History Builder

> 本文件是 Development Trace & History 功能 P1 阶段的详细执行计划。
> 基线：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`，P0 已完成并验证通过。
>
> P1 目标：Workflow 执行结束后自动采集全部 Agent 的 Session Trace，落盘为不可变 History，
> 支持父子 Workflow、并行 Agent、Retry 和 Resume，形成可追溯的执行档案。
>
> P1 不实现 development 开关和自动优化触发（P2 范围）。

## 类头流程图：P1 数据流

```
 P1 从执行到 History 落盘的完整数据流

 Workflow 执行完成 completed failed aborted
        |
        v
 RunFinalizer 统一入口
   前台 workflow.ts finally
   后台 background-runs.ts finally
   定时经 onFinished 间接覆盖
        |
        v
 遍历全部 Agent Record
   筛选非回放 agent 取 sessionId
   回放 agent 标记 provenance
        |
        v
 Adapter collectSessionTrace
   调 session.messages 拉取全部消息
   喂 parseSessionMessages 解析
   返回 ToolCallEvent 数组
        |
        v
 TraceStore 落盘
   traces/sessionId.jsonl 每会话一条
   manifest.json 采集完整性
        |
        v
 HistoryBuilder 合并
   执行树 父子 Workflow 层级
   全局时间线 按时间排序
   回放 agent 来源关联
        |
        v
 写出 history.jsonl + history.md
```

## 一、P1 范围与交付物

| 子项 | 内容 | 依赖 |
|------|------|------|
| TraceStore | 文件持久化：traces/、manifest.json | P0 collector.ts |
| Adapter 扩展 | collectSessionTrace 方法 | P0 collector.ts |
| RunFinalizer | 统一三路径终态采集入口 | TraceStore + Adapter |
| HistoryBuilder | 合并执行树 + 全局时间线 | TraceStore |
| Resume Provenance | 回放 agent 来源关联 | TraceStore + journal |
| 接线改动 | workflow.ts + background-runs.ts finally 块 | RunFinalizer |
| runAttemptId | 区分 Resume 轮次 | 工具层生成 |

P1 完成后，给定一个 `runId`，能从 `history/<runId>/` 还原整个 Workflow（含子 Workflow）实际做了什么。

## 二、模块结构

```
src/
├── trace/
│   ├── collector.ts          # P0 已完成：parseSessionMessages
│   ├── store.ts              # P1 新增：TraceStore 文件持久化
│   └── types.ts              # P1 新增：TraceManifest / TraceProvenance 类型
├── history/
│   ├── builder.ts            # P1 新增：HistoryBuilder 合并执行树与时间线
│   └── schema.ts             # P1 新增：history.jsonl / history.md 形状定义
├── tools/
│   ├── run-finalizer.ts      # P1 新增：RunFinalizer 统一终态采集
│   ├── workflow.ts           # P1 改动：finally 块接 RunFinalizer
│   └── background-runs.ts    # P1 改动：finally 块接 RunFinalizer
├── adapters/
│   └── opencode-session-adapter.ts  # P1 改动：新增 collectSessionTrace
```

架构约束（AGENTS.md）：
- `src/trace/` 和 `src/history/` 禁止 import `@opencode-ai/plugin` / `@opencode-ai/sdk`——宿主无关
- `src/tools/run-finalizer.ts` 可 import adapter 和 trace/history 模块
- `src/adapters/` 是唯一调用 `client.session.messages()` 的位置

## 三、TraceStore 实现

### 3.1 落盘结构

```
.opencode-workflows/
└── history/
    └── run-abc123/
        ├── manifest.json          # Run 元数据 + 采集完整性
        ├── traces/
        │   ├── ses-a.jsonl        # 每会话一条 JSONL（每行一个 ToolCallEvent）
        │   └── ses-b.jsonl
        ├── history.jsonl          # 合并后的全局时间线（机器可读）
        └── history.md             # 人与 LLM 可读整理视图
```

### 3.2 类型定义

**新建文件：`src/trace/types.ts`**

```typescript
/** Run 的采集清单（manifest.json 的形状） */
export interface TraceManifest {
  version: 1
  runId: string
  /** 区分同一 runId 的不同执行轮次（Resume 场景） */
  runAttemptId: string
  /** 根 Run ID（嵌套子 Run 归属） */
  rootRunId: string
  parentRunId?: string
  startedAt: number
  endedAt: number
  status: "completed" | "failed" | "aborted"
  /** 采集完整性 */
  completeness: "full" | "partial" | "failed"
  /** 触发来源（manual / schedule / development-optimizer） */
  trigger?: { type: string; scheduleId?: string; scheduledAt?: string }
  /** 各 Session 的采集明细 */
  sessions: Array<SessionManifestEntry>
}

/** 单个 Session 的采集记录 */
export interface SessionManifestEntry {
  sessionId: string
  agentLabel: string
  agentId: string
  /** 所属子 Workflow 的 scopePath */
  workflowScopePath?: string[]
  /** 事件数 */
  eventCount: number
  /** 是否为 Journal 回放（无新 session） */
  replayed: boolean
  /** 回放来源（replayed=true 时指向原始执行） */
  sourceRunAttemptId?: string
  sourceSessionId?: string
  /** 输出完整性 */
  outputIntegrity: "full" | "truncated-only" | "missing" | "unavailable"
  /** 采集错误（拉取失败时记录原因） */
  collectionError?: string
}
```

### 3.3 TraceStore 实现

**新建文件：`src/trace/store.ts`**

```typescript
/**
 * TraceStore —— Trace 文件的持久化（P1）
 *
 * 存储布局：
 *  <项目目录>/.opencode-workflows/history/<runId>/
 *    manifest.json     -> TraceManifest
 *    traces/<sid>.jsonl -> 每行一个 ToolCallEvent（JSON）
 *
 * 写入时机：RunFinalizer 在 Run 终态后逐 session 写入。
 * 读取时机：HistoryBuilder 合并时读 traces/；Resume 时检查原始 Trace 是否存在。
 *
 * 落盘策略与 JournalStore / run-snapshot 一致：
 *  - 原子写（tmp + rename，Windows 下 unlink 后重试）
 *  - 落盘失败不阻断运行（Trace 是尽力而为的观测通道）
 *  - 同步 IO（非热路径，Run 已终态）
 */

import fs from "node:fs"
import path from "node:path"
import type { ToolCallEvent } from "./collector.js"
import type { TraceManifest } from "./types.js"

const HISTORY_DIR = path.join(".opencode-workflows", "history")

export class TraceStore {
  private readonly baseDir: string

  constructor(projectDir: string) {
    this.baseDir = path.join(projectDir, HISTORY_DIR)
  }

  /** Run 的 History 根目录 */
  runDir(runId: string): string {
    return path.join(this.baseDir, runId)
  }

  /** 写入单会话 Trace（JSONL：每行一个事件） */
  writeSessionTrace(runId: string, sessionId: string, events: ToolCallEvent[]): void {
    const dir = path.join(this.runDir(runId), "traces")
    const file = path.join(dir, `${sessionId}.jsonl`)
    const lines = events.map((e) => JSON.stringify(e)).join("\n")
    this.writeAtomic(file, lines + "\n")
  }

  /** 写入 manifest */
  writeManifest(runId: string, manifest: TraceManifest): void {
    const file = path.join(this.runDir(runId), "manifest.json")
    this.writeAtomic(file, JSON.stringify(manifest, null, 2))
  }

  /** 写入合并后的 History（JSONL） */
  writeHistory(runId: string, jsonl: string): void {
    const file = path.join(this.runDir(runId), "history.jsonl")
    this.writeAtomic(file, jsonl)
  }

  /** 写入人可读 History（Markdown） */
  writeHistoryMd(runId: string, md: string): void {
    const file = path.join(this.runDir(runId), "history.md")
    this.writeAtomic(file, md)
  }

  /** 读取单会话 Trace */
  readSessionTrace(runId: string, sessionId: string): ToolCallEvent[] {
    try {
      const file = path.join(this.runDir(runId), "traces", `${sessionId}.jsonl`)
      const raw = fs.readFileSync(file, "utf8")
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ToolCallEvent)
    } catch {
      return []
    }
  }

  /** 读取 manifest */
  readManifest(runId: string): TraceManifest | null {
    try {
      const file = path.join(this.runDir(runId), "manifest.json")
      return JSON.parse(fs.readFileSync(file, "utf8")) as TraceManifest
    } catch {
      return null
    }
  }

  /** 检查某 session 的 Trace 是否已存在（Resume provenance 用） */
  hasSessionTrace(runId: string, sessionId: string): boolean {
    try {
      fs.accessSync(path.join(this.runDir(runId), "traces", `${sessionId}.jsonl`))
      return true
    } catch {
      return false
    }
  }

  /** 原子写：mkdir + tmp + rename（Windows 兼容，同 JournalStore / run-snapshot 范式） */
  private writeAtomic(file: string, content: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      try {
        fs.writeFileSync(tmp, content, "utf8")
        try {
          fs.renameSync(tmp, file)
        } catch {
          fs.rmSync(file, { force: true })
          fs.renameSync(tmp, file)
        }
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
      }
    } catch {
      // 落盘失败不阻断运行
    }
  }
}
```

## 四、Adapter 扩展

**改动文件：`src/adapters/opencode-session-adapter.ts`**

新增 `collectSessionTrace` 方法。这是唯一调用 `client.session.messages()` 的位置。

```typescript
export class OpenCodeSessionAdapter implements AgentSessionRunner {
  // ... 现有代码不变 ...

  /**
   * 采集某 Session 的完整工具调用 Trace（P1）。
   * 调 session.messages() 拉取全部消息，喂 parseSessionMessages 解析。
   *
   * 每个 agent() 调用创建独立 session，一次 prompt 产生多条 Assistant 消息，
   * 全部 ToolPart 分布在各条消息中——不能只取最后一条。
   */
  async collectSessionTrace(
    sessionId: string,
    directory?: string,
  ): Promise<ToolCallEvent[]> {
    try {
      const result = await this.client.session.messages({
        path: { id: sessionId },
        query: directory ? { directory } : undefined,
      })
      if (result.error) return []
      const messages = result.data as RawSessionMessage[]
      return parseSessionMessages(messages)
    } catch {
      // session 可能已清理或服务端不可达；返回空数组，manifest 标记 missing
      return []
    }
  }
}
```

需在文件顶部新增 import：
```typescript
import { parseSessionMessages, type ToolCallEvent, type RawSessionMessage } from "../trace/collector.js"
```

**注意**：`collectSessionTrace` 返回空数组时，RunFinalizer 据此在 manifest 标记 `outputIntegrity: "missing"`。不抛错，不阻断 History 构建。

## 五、RunFinalizer 实现

**新建文件：`src/tools/run-finalizer.ts`**

这是 P1 的核心编排模块，在 Run 终态后统一采集 Trace 并构建 History。

```typescript
/**
 * RunFinalizer —— Run 终态后统一采集 Trace 与构建 History（P1）
 *
 * 接入点：
 *  - 前台 workflow.ts 的 finally 块
 *  - 后台 background-runs.ts 的 finally 块（定时经此间接覆盖）
 *
 * 流程：
 *  1. 遍历 agents，筛选有 sessionId 的非回放 agent
 *  2. 对每个调 adapter.collectSessionTrace 拉取 ToolCallEvent
 *  3. TraceStore 逐会话落盘
 *  4. 回放 agent 标记 provenance（引用原始 sessionId）
 *  5. HistoryBuilder 合并执行树 + 全局时间线
 *  6. 写 manifest.json（含采集完整性）
 *
 * 约束：
 *  - 采集失败不阻断 run 终态（Trace 是尽力而为）
 *  - 优化 Job 的失败绝不改变已成功业务 Workflow 的状态
 *  - 回放 agent 无新 session，不调 session.messages()
 */

import type { OpenCodeSessionAdapter } from "../adapters/opencode-session-adapter.js"
import { TraceStore } from "../trace/store.js"
import type { TraceManifest, SessionManifestEntry } from "../trace/types.js"
import type { ToolCallEvent } from "../trace/collector.js"
import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../types/index.js"
import { buildHistory } from "../history/builder.js"

export interface FinalizerInput {
  runId: string
  runAttemptId: string
  rootRunId: string
  parentRunId?: string
  directory: string
  status: "completed" | "failed" | "aborted"
  startedAt: number
  agents: AgentRecord[]
  workflows: WorkflowExecutionRecord[]
  composites: CompositeRecord[]
  adapter: OpenCodeSessionAdapter
  trigger?: { type: string; scheduleId?: string; scheduledAt?: string }
  /** 原 runId（Resume 场景，用于回放 agent 的 Trace 回溯） */
  resumeFromRunId?: string
}

export interface FinalizerResult {
  historyPath: string
  manifest: TraceManifest
  completeness: "full" | "partial" | "failed"
}

/** Run 终态后采集 Trace 并构建 History */
export async function finalizeRun(input: FinalizerInput): Promise<FinalizerResult> {
  const store = new TraceStore(input.directory)
  const sessionEntries: SessionManifestEntry[] = []
  const allEvents: Array<{ sessionId: string; agentId: string; events: ToolCallEvent[] }> = []

  for (const agent of input.agents) {
    const isReplayed = agent.replayed === true

    if (!isReplayed && agent.sessionId) {
      // 真实执行：拉取 session.messages() 并解析
      const events = await input.adapter.collectSessionTrace(agent.sessionId, input.directory)
      store.writeSessionTrace(input.runId, agent.sessionId, events)
      allEvents.push({ sessionId: agent.sessionId, agentId: agent.id, events })

      sessionEntries.push({
        sessionId: agent.sessionId,
        agentLabel: agent.label,
        agentId: agent.id,
        workflowScopePath: agent.workflowScopePath,
        eventCount: events.length,
        replayed: false,
        outputIntegrity: events.length > 0 ? "full" : "missing",
      })
    } else if (isReplayed) {
      // 回放 agent：无新 session，引用原始执行
      const originalSessionId = agent.sessionId  // journal 回填的原始 sessionId
      const hasOriginalTrace = originalSessionId
        ? store.hasSessionTrace(input.resumeFromRunId ?? input.runId, originalSessionId)
        : false

      sessionEntries.push({
        sessionId: originalSessionId ?? "",
        agentLabel: agent.label,
        agentId: agent.id,
        workflowScopePath: agent.workflowScopePath,
        eventCount: 0,
        replayed: true,
        sourceRunAttemptId: input.resumeFromRunId,
        sourceSessionId: originalSessionId,
        outputIntegrity: hasOriginalTrace ? "full" : "unavailable",
      })
    } else {
      // 无 sessionId 的 agent（异常或未执行到 session 创建）
      sessionEntries.push({
        sessionId: "",
        agentLabel: agent.label,
        agentId: agent.id,
        workflowScopePath: agent.workflowScopePath,
        eventCount: 0,
        replayed: false,
        outputIntegrity: "unavailable",
        collectionError: "agent 无 sessionId（未执行到 session 创建阶段）",
      })
    }
  }

  // 采集完整性判定
  const collected = sessionEntries.filter((s) => !s.replayed && s.outputIntegrity === "full").length
  const realTotal = sessionEntries.filter((s) => !s.replayed).length
  const completeness: "full" | "partial" | "failed" =
    collected === 0 ? "failed" : collected < realTotal ? "partial" : "full"

  // 构建 History
  const history = buildHistory({
    runId: input.runId,
    runAttemptId: input.runAttemptId,
    agents: input.agents,
    workflows: input.workflows,
    composites: input.composites,
    sessionEvents: allEvents,
    sessionEntries,
    startedAt: input.startedAt,
    endedAt: Date.now(),
    status: input.status,
  })

  store.writeHistory(input.runId, history.jsonl)
  store.writeHistoryMd(input.runId, history.md)

  // 写 manifest
  const manifest: TraceManifest = {
    version: 1,
    runId: input.runId,
    runAttemptId: input.runAttemptId,
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId,
    startedAt: input.startedAt,
    endedAt: Date.now(),
    status: input.status,
    completeness,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    sessions: sessionEntries,
  }
  store.writeManifest(input.runId, manifest)

  return {
    historyPath: store.runDir(input.runId),
    manifest,
    completeness,
  }
}
```

## 六、HistoryBuilder 实现

**新建文件：`src/history/schema.ts`**

```typescript
/** history.jsonl 每行的形状（全局时间线事件） */
export interface HistoryEvent {
  /** 事件类型 */
  type: "workflow_start" | "workflow_end" | "agent_start" | "agent_end" | "tool_call"
  /** 时间戳（毫秒） */
  ts: number
  /** 所属 Workflow scopePath */
  scopePath?: string[]
  /** 关联的 agent ID（agent/tool 事件） */
  agentId?: string
  /** 关联的 agent label */
  agentLabel?: string
  /** 工具调用事件（type=tool_call 时） */
  tool?: string
  callID?: string
  status?: string
  /** 简要输入预览（工具调用时） */
  inputPreview?: string
  /** 是否为回放 */
  replayed?: boolean
}
```

**新建文件：`src/history/builder.ts`**

```typescript
/**
 * HistoryBuilder —— 合并执行树与全局时间线（P1）
 *
 * 输入：AgentRecord 数组 + WorkflowExecutionRecord + 各 session 的 ToolCallEvent
 * 输出：history.jsonl（机器可读时间线） + history.md（人可读整理视图）
 *
 * 纯函数，无 IO（写入由 RunFinalizer 负责）。
 */

import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../types/index.js"
import type { ToolCallEvent } from "../trace/collector.js"
import type { SessionManifestEntry } from "../trace/types.js"
import type { HistoryEvent } from "./schema.js"

export interface HistoryBuildInput {
  runId: string
  runAttemptId: string
  agents: AgentRecord[]
  workflows: WorkflowExecutionRecord[]
  composites: CompositeRecord[]
  sessionEvents: Array<{ sessionId: string; agentId: string; events: ToolCallEvent[] }>
  sessionEntries: SessionManifestEntry[]
  startedAt: number
  endedAt: number
  status: string
}

export interface HistoryBuildResult {
  jsonl: string
  md: string
}

export function buildHistory(input: HistoryBuildInput): HistoryBuildResult {
  const events: HistoryEvent[] = []

  // 1. Workflow 执行树事件
  for (const wf of input.workflows) {
    events.push({
      type: "workflow_start",
      ts: wf.startedAt,
      scopePath: wf.scopePath,
    })
    if (wf.endedAt) {
      events.push({
        type: "workflow_end",
        ts: wf.endedAt,
        scopePath: wf.scopePath,
        status: wf.status,
      })
    }
  }

  // 2. Agent 事件 + 工具调用事件
  // 建立 sessionId -> events 的索引
  const eventsByAgent = new Map<string, ToolCallEvent[]>()
  for (const se of input.sessionEvents) {
    eventsByAgent.set(se.agentId, se.events)
  }

  for (const agent of input.agents) {
    if (agent.startedAt) {
      events.push({
        type: "agent_start",
        ts: agent.startedAt,
        agentId: agent.id,
        agentLabel: agent.label,
        scopePath: agent.workflowScopePath,
        replayed: agent.replayed,
      })
    }
    // 该 agent 的工具调用事件（按时间线插入）
    const toolEvents = eventsByAgent.get(agent.id) ?? []
    for (const te of toolEvents) {
      events.push({
        type: "tool_call",
        ts: te.startedAt ?? agent.startedAt ?? input.startedAt,
        agentId: agent.id,
        agentLabel: agent.label,
        scopePath: agent.workflowScopePath,
        tool: te.tool,
        callID: te.callID,
        status: te.status,
        inputPreview: JSON.stringify(te.input).slice(0, 120),
        replayed: agent.replayed,
      })
    }
    if (agent.durationMs !== undefined && agent.startedAt) {
      events.push({
        type: "agent_end",
        ts: agent.startedAt + agent.durationMs,
        agentId: agent.id,
        agentLabel: agent.label,
        scopePath: agent.workflowScopePath,
        status: agent.status,
        replayed: agent.replayed,
      })
    }
  }

  // 按时间戳排序
  events.sort((a, b) => a.ts - b.ts)

  // 生成 JSONL
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n")

  // 生成 Markdown
  const md = buildMarkdown(input, events)

  return { jsonl, md: jsonl ? md : "" }
}

function buildMarkdown(input: HistoryBuildInput, events: HistoryEvent[]): string {
  const lines: string[] = []
  lines.push(`# Workflow History: ${input.runId}`)
  lines.push("")
  lines.push(`- Run Attempt: ${input.runAttemptId}`)
  lines.push(`- Status: ${input.status}`)
  lines.push(`- Duration: ${formatDuration(input.endedAt - input.startedAt)}`)
  lines.push(`- Agents: ${input.agents.length}`)
  lines.push(`- Workflows: ${input.workflows.length}`)
  lines.push("")

  // 执行树
  lines.push("## Execution Tree")
  for (const wf of input.workflows) {
    const indent = "  ".repeat(Math.max(0, wf.scopePath.length - 1))
    const duration = wf.durationMs !== undefined ? ` (${formatDuration(wf.durationMs)})` : ""
    lines.push(`${indent}- [${wf.status}] ${wf.label}${duration}`)
  }
  lines.push("")

  // 工具调用序列
  lines.push("## Tool Call Sequence")
  for (const e of events) {
    if (e.type === "tool_call") {
      const replayed = e.replayed ? " [replayed]" : ""
      lines.push(`- ${e.ts} | ${e.agentLabel} | ${e.tool} [${e.status}]${replayed}`)
      if (e.inputPreview) {
        lines.push(`  input: ${e.inputPreview}`)
      }
    }
  }
  lines.push("")

  // 回放 agent 来源
  const replayed = input.sessionEntries.filter((s) => s.replayed)
  if (replayed.length > 0) {
    lines.push("## Replayed Agents (from Journal)")
    for (const r of replayed) {
      const source = r.sourceRunAttemptId ?? "unknown"
      lines.push(`- ${r.agentLabel} <- ${source} (session: ${r.sourceSessionId ?? "n/a"})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}
```

## 七、runAttemptId 生成

在工具层生成，区分同一 runId 的不同执行轮次（Resume 场景）。

**改动文件：`src/tools/workflow.ts`**

```typescript
// 现有：const runId = input.resumeFromRunId ?? `run-${Date.now().toString(36)}`
// 新增：
const runAttemptId = `${runId}:${Date.now().toString(36)}`
```

**改动文件：`src/tools/background-runs.ts`**

```typescript
// 现有：const runId = `run-${Date.now().toString(36)}-${++this.seq}`
// 新增（在 start 方法内）：
const runAttemptId = `${runId}:${Date.now().toString(36)}`
```

runAttemptId 传入 RunFinalizer，写入 manifest。同一 runId 的多次 Resume 执行有不同的 runAttemptId，History 文件按 runId 归档（覆写），manifest 记录最新 runAttemptId。

## 八、接线改动

### 8.1 前台 workflow.ts

在 `finally` 块中调用 RunFinalizer。当前 finally 块（`workflow.ts:289-291`）：

```typescript
finally {
  clearInterval(heartbeat)
  context.abort.removeEventListener("abort", onAbort)
  unregisterAgentSessions(registeredSessions)
}
```

改为：

```typescript
finally {
  clearInterval(heartbeat)
  context.abort.removeEventListener("abort", onAbort)
  unregisterAgentSessions(registeredSessions)
  // P1: Trace 采集与 History 构建（不阻断 run 终态）
  try {
    await finalizeRun({
      runId,
      runAttemptId,
      rootRunId: rootSessionId,
      directory: context.directory,
      status: /* 从 try/catch 上下文获取 */,
      startedAt: /* run 开始时间 */,
      agents: progressRecords,
      workflows: /* 从 result 或 progressRecords 推导 */,
      composites: progressComposites,
      adapter,
      trigger: { type: "manual" },
      resumeFromRunId: input.resumeFromRunId,
    })
  } catch {
    // 采集失败不阻断
  }
}
```

**注意**：前台路径的 `finally` 块需要拿到 run 的终态状态（completed/failed/aborted）和 `result`（成功时）。当前结构中，`result` 在 try 块内可用，但 finally 块拿不到。需要在 try/catch 外声明一个变量保存终态：

```typescript
let runStatus: "completed" | "failed" | "aborted" = "aborted"
let runResult: WorkflowRunResult<unknown> | undefined
// try 块成功时：runStatus = "completed"; runResult = result
// catch abort 时：runStatus = "aborted"
// catch 其他错误时：runStatus = "failed"
```

### 8.2 后台 background-runs.ts

后台路径的 finally 块（`background-runs.ts:284-289`）已有 `info.status`（completed/failed/aborted）和 `info.records`。改 finally 块：

```typescript
finally {
  clearInterval(heartbeat)
  info.endedAt = Date.now()
  if (info.logs.length > MAX_KEPT_LOGS) info.logs = info.logs.slice(-MAX_KEPT_LOGS)
  unregisterAgentSessions(registeredSessions)
  this.prune()
  // P1: Trace 采集与 History 构建
  try {
    await finalizeRun({
      runId: info.runId,
      runAttemptId,  // 需在 start 内生成并传入 execute
      rootRunId,
      directory: deps.directory,
      status: info.status,
      startedAt: info.startedAt,
      agents: info.records,
      workflows: /* 需从 runWorkflow 结果获取 */,
      composites: info.composites,
      adapter,
      trigger: input.trigger,
      resumeFromRunId: undefined,
    })
  } catch {
    // 采集失败不阻断
  }
}
```

**问题**：后台路径当前 `info` 只保存 `records` 和 `composites`，不保存 `workflows`（WorkflowExecutionRecord）。需要在 `runWorkflow` 的 options 中新增 `onWorkflowUpdate` 回调，或从 `result`（成功时）获取。

**最小改法**：成功路径的 `result.workflows` 已可用。失败路径无 result，`workflows` 为空数组（manifest 标 partial）。或新增 `onWorkflowUpdate` 回调收集。

### 8.3 定时 schedule/runtime.ts

不改。ScheduleRuntime 经 `BackgroundRunManager.start()` 执行，`onFinished` 回调在 background-runs.ts 的 finally 之前调用。只要 background-runs.ts 的 finally 块接了 RunFinalizer，定时路径自动覆盖。

## 九、Resume Provenance 实现

回放 agent 的 Trace 来源关联在 RunFinalizer 中已实现（第五节）。补充逻辑：

1. 回放 agent 的 `record.replayed === true`，`record.sessionId` 是 journal 回填的原始 sessionId
2. RunFinalizer 检查 `store.hasSessionTrace(resumeFromRunId, originalSessionId)`
3. 如果原始 Trace 存在（上次执行已采集），标记 `outputIntegrity: "full"`
4. 如果不存在（旧 run 未采集或已清理），标记 `outputIntegrity: "unavailable"`
5. HistoryBuilder 在 Markdown 中单独列出回放 agent 的来源

## 十、测试计划

### 10.1 单元测试

**新建文件：`tests/trace-store.test.ts`**

| 用例 | 验证点 |
|------|--------|
| writeSessionTrace + readSessionTrace roundtrip | 写入后能读回，JSONL 格式正确 |
| writeManifest + readManifest roundtrip | manifest JSON 结构完整 |
| hasSessionTrace | 文件存在返回 true，不存在返回 false |
| 不存在的 runId 读回空 | readSessionTrace 返回 []，readManifest 返回 null |
| 落盘失败不抛错 | 只读目录降级，不阻断 |

**新建文件：`tests/history-builder.test.ts`**

| 用例 | 验证点 |
|------|--------|
| 单 Workflow 单 Agent 单工具 | 事件序列正确：workflow_start → agent_start → tool_call → agent_end → workflow_end |
| 父子 Workflow | scopePath 层级正确，事件按时间排序 |
| 并行 Agent | 时间线允许多 Agent 事件交叠 |
| 回放 Agent | replayed=true 的 agent 无 tool_call 事件，但 agent_start/end 仍记录 |
| 空输入 | 不报错，产出空 jsonl 和最小 md |
| Markdown 格式 | 标题、执行树、工具序列、回放来源各段齐全 |

**新建文件：`tests/run-finalizer.test.ts`**

| 用例 | 验证点 |
|------|--------|
| 正常完成采集 | manifest.completeness = "full"，traces/ 有文件 |
| 部分 agent 无 sessionId | completeness = "partial" |
| 全部采集失败 | completeness = "failed"，manifest 仍写入 |
| 回放 agent provenance | replayed=true 的 session 标 outputIntegrity |
| adapter.collectSessionTrace 返回空 | outputIntegrity = "missing" |

### 10.2 联调验证

在 `dev-examples/development-trace/` 启动 OpenCode，运行 `trace-verify.js`：

1. 执行完成后检查 `.opencode-workflows/history/<runId>/` 目录是否存在
2. 检查 `manifest.json` 的 completeness 是否为 "full"
3. 检查 `traces/` 下每个 session 的 jsonl 文件是否含完整 ToolCallEvent
4. 检查 `history.jsonl` 是否按时间排序且包含全部事件
5. 检查 `history.md` 是否可读且有执行树 + 工具序列

Resume 验证：
1. 修改 `trace-verify.js` 的某个 agent prompt
2. 用 `resumeFromRunId` 重跑
3. 检查 manifest 中回放 agent 的 `replayed: true` 和 `sourceRunAttemptId`
4. 检查回放 agent 的 `outputIntegrity` 是否正确标记

## 十一、验收标准

| 编号 | 验收项 | 验证方式 |
|------|--------|----------|
| V-1 | TraceStore 读写 roundtrip | `tests/trace-store.test.ts` 通过 |
| V-2 | HistoryBuilder 事件序列正确 | `tests/history-builder.test.ts` 通过 |
| V-3 | RunFinalizer 三种 completeness 判定 | `tests/run-finalizer.test.ts` 通过 |
| V-4 | 回放 agent provenance 标记正确 | `tests/run-finalizer.test.ts` 通过 |
| V-5 | 前台 workflow 执行后生成 history 目录 | 联调验证 |
| V-6 | manifest completeness 为 full（全部 agent 采集成功） | 联调验证 |
| V-7 | history.jsonl 按时间排序且含全部工具调用 | 联调验证 |
| V-8 | history.md 可读且有执行树 + 工具序列 | 联调验证 |
| V-9 | Resume 后回放 agent 标记 replayed + provenance | 联调验证 |
| V-10 | 采集失败不阻断 run 终态 | 单元测试 + 联调验证 |
| V-11 | typecheck + npm test 全量不回归 | `npm run typecheck && npm test` |

## 十二、执行顺序

```
第一步  类型定义
        新建 src/trace/types.ts
        新建 src/history/schema.ts
          |
          v
第二步  TraceStore
        新建 src/trace/store.ts
        新建 tests/trace-store.test.ts
        npm run typecheck && npx tsx --test tests/trace-store.test.ts
          |
          v
第三步  HistoryBuilder
        新建 src/history/builder.ts
        新建 tests/history-builder.test.ts
        npm run typecheck && npx tsx --test tests/history-builder.test.ts
          |
          v
第四步  Adapter 扩展
        改 src/adapters/opencode-session-adapter.ts（加 collectSessionTrace）
        npm run typecheck
          |
          v
第五步  RunFinalizer
        新建 src/tools/run-finalizer.ts
        新建 tests/run-finalizer.test.ts（fake adapter）
        npm run typecheck && npx tsx --test tests/run-finalizer.test.ts
          |
          v
第六步  接线改动
        改 src/tools/workflow.ts（finally 块 + runAttemptId）
        改 src/tools/background-runs.ts（finally 块 + runAttemptId）
        npm run typecheck
          |
          v
第七步  全量验证
        npm run typecheck && npm test
        npm run build
        联调验证（dev-examples/development-trace）
```

## 十三、风险与降级方案

| 风险 | 影响 | 降级 |
|------|------|------|
| session.messages() 调用失败 | 该 agent Trace 缺失 | manifest 标 missing，不阻断 History 构建 |
| 后台路径无 workflows 数据 | History 执行树不完整 | 从 agent.workflowScopePath 重建最小树 |
| Resume 时原始 Trace 已清理 | 回放 agent 证据缺失 | manifest 标 unavailable，History 标 evidence 不足 |
| 大量 agent 导致采集耗时 | RunFinalizer 阻塞 finally | 第一版串行采集；后续可并行 session.messages() |
| history 目录磁盘空间 | 无限增长 | P1 暂不做保留期清理；后续按 manifest.endedAt 过期删除 |

## 十四、引用说明

本执行文档核对的仓库源码位置：

- P0 collector.ts（parseSessionMessages 基础）：`src/trace/collector.ts`
- 前台 finally 块（接线点）：`src/tools/workflow.ts:260-291`
- 后台 finally 块（接线点）：`src/tools/background-runs.ts:254-289`
- runWorkflow 返回值（含 agents/workflows/composites）：`src/runtime/workflow-runtime.ts:307-319`
- WorkflowRunResult 类型：`src/types/index.ts:133-147`
- AgentRecord（含 sessionId/replayed/workflowScopePath）：`src/types/index.ts:64-106`
- WorkflowExecutionRecord（含 scopePath）：`src/types/index.ts:42-61`
- JournalStore 原子写范式：`src/persistence/journal.ts:92-116`
- run-snapshot 原子写范式：`src/tools/run-snapshot.ts`
- OpenCodeSessionAdapter（扩展点）：`src/adapters/opencode-session-adapter.ts`
- session.messages SDK 类型：`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2209-2243`
- ScheduleRuntime（经 onFinished 间接覆盖）：`src/schedule/runtime.ts:162-167`
- v2 评审修订（P1 范围定义）：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`
- P0 执行文档（前置阶段）：`dev-docs/planning/新增Workflow追踪分析-P0执行文档.md`
