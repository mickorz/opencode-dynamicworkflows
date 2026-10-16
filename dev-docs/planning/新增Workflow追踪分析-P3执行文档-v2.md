# P3 执行文档 v3 - Analyzer 五类规则 + Skill 集成

> 本文件基于 P3 v2 第二轮评审修订，是 Development Trace & History 功能 P3 阶段的详细执行计划。
> 基线：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`，P0/P1/P2 已完成并验证通过。
> 评审基线：本地 main 分支含 P0/P1/P2 全部源码（commit e3c77d4 之后本地增量）。
>
> P3 v3 目标：将 P2 的 LLM 驱动分析替换为结构化 TypeScript 代码分析（五类规则），
> 产出确定性、可复算的分析报告与优化候选，并与 workflow-optimize Skill 输入契约对齐。
>
> P3 不实现自动改写原 Workflow 脚本（第一版禁止）。

## 评审修订摘要（v2 → v3）

| 评审问题 | v2 | v3 修正 |
|---------|-----|---------|
| stableStringify bug | `JSON.stringify(obj, Object.keys().sort())` 过滤嵌套属性 | 递归排序对象键的稳定序列化 |
| 脚本确定性判断不可靠 | `hasDeterministicLogic: boolean`（静态排除 Date.now） | `DeterminismAssessment = likely/unknown/unlikely` |
| readToolOutput 安全检查 | `startsWith(projectRoot)` 字符串前缀 | 移到 Adapter 层，校验实际路径归属 |
| 失败回退链路不完整 | 预计算失败不写报告但 Optimizer 仍读报告 | 拆为两条明确分支 + History 可用性检查 |
| callID 状态重复 | 未去重 pending/running/completed | 适配层按 callID 归并逻辑调用 |
| edit 脚本片段 | 当作完整脚本处理 | 无法还原时降低 evidenceIntegrity |
| AgentRecord 来源 | 从 manifest.sessions 推导简化版 | 使用真实 AgentRecord，缺失字段标 unknown |
| Proposal 身份不稳定 | runId + category + 8 位签名 | 区分 occurrence ID 与 candidateFingerprint |
| Repeat/Latency 生成 Proposal | 满足阈值就生成 | 改为纯 Observation，不直接生成 Proposal |
| 联调验收时序 | 立即检查文件 | 等待 Job 终态后再检查 |
| Optimizer Agent 数据传递 | 审阅结果未传入增补 Agent | 传入 review 变量 |

## 类头流程图：P3 v2 分析闭环

```
 P3 v2 从 History 到结构化分析报告的完整流程

 DevJobManager createOnce
        |
        v
 读取 History 文件
   manifest json
   traces 逐 session jsonl
        |
        v
 适配层 统一 AnalysisToolEvent
   合并 ToolCallEvent 与 Session Manifest Entry
   每个 event 携带 agentId agentLabel sessionId workflowScopePath
        |
        v
 五类规则纯 TypeScript 函数
   Rule1 重复操作检测
     sha256 签名 同 tool 同 normalizeInput
   Rule2 失败重试链
     error 后同 tool 加时间窗口与参数关联
   Rule3 顺序依赖链
     write 产物被后续 read bash 消费
   Rule4 耗时分布
     per Agent 内 Next startedAt 减 Prev endedAt
   Rule5 脚本固化候选
     write bash heredoc 创建脚本 被执行 结果正常
        |
        v
 证据评估
   evidenceIntegrity 完整 缺失 截断
   candidateConfidence 高 中 低
        |
        v
 生成 report md proposals json 纯函数
   generatedAt 外部注入
        |
        v
 记录分析状态
   analysisMode deterministic 或 llm fallback
   analysisStatus completed partial failed
        |
        v
 Optimizer Agent 审阅增补 可选 LLM 层
   读预计算结果 检查准确性
   补充人类可读洞察
   不覆盖确定性证据
        |
        v
 Skill 输入契约对齐
   proposals json 含 targetPath suggestedChange validationPlan
   供 workflow optimize skill 第2步消费
```

## 一、P3 v2 范围与交付物

| 子项 | 内容 | 优先级 |
|------|------|--------|
| P3-A 统一 AnalysisToolEvent | 适配层合并 ToolCallEvent + Session/Agent 元数据 | P0 |
| P3-B 四类规则修正 | repeat hash / retry 窗口 / latency per-agent / dependency 精确匹配 | P0 |
| P3-C Script Extraction 候选 | 识别 write/heredoc 创建的脚本 + 执行关联 + 可固化判定 | P0 |
| P3-D 证据与 Proposal Schema | evidenceIntegrity + candidateConfidence + Proposal 完整字段 | P0 |
| P3-E DevJobManager 预计算 | startOptimizer 前跑分析器 + 状态记录 + 持久化 | P0 |
| P3-F Optimizer Agent 审阅 | 接收预计算结果 + 增补不覆盖 | P1 |
| P3-G Skill 输入契约验证 | proposals.json 对齐 skill 第2步格式 | P1 |

## 二、模块结构

```
src/
├── development/
│   ├── analyzer/
│   │   ├── types.ts              # P3-A: AnalysisToolEvent / AnalysisResult / Proposal
│   │   ├── adapter.ts             # P3-A: ToolCallEvent[] + Manifest -> AnalysisToolEvent[]
│   │   ├── rules.ts               # P3-B: 四类规则纯函数
│   │   ├── script-extraction.ts   # P3-C: 第五类规则
│   │   ├── evidence.ts            # P3-D: evidenceIntegrity + candidateConfidence
│   │   ├── report-builder.ts      # P3-D: 生成 report.md + proposals.json（纯函数）
│   │   └── index.ts               # P3-E: 分析入口 analyzeRun
│   ├── job-manager.ts              # P3-E 改动: 预计算 + 状态记录
│   └── optimizer-script.ts         # P3-F 改动: 接收预计算 args
├── trace/
│   └── store.ts                    # P3-E 扩展: writeAnalysis + readToolOutput(安全)
```

架构约束（AGENTS.md）：
- `src/development/analyzer/` 禁止 import SDK——纯 TypeScript 纯函数
- 分析器消费 `AnalysisToolEvent[]` 和 `TraceManifest`，产出 `AnalysisResult`
- 报告生成器是纯函数，`generatedAt` 由外部注入
- 不使用 console.log/error（CLAUDE.md 约束）

## 三、P3-A：统一 AnalysisToolEvent

### 3.1 问题

`ToolCallEvent`（P0 collector.ts）只有 `callID`/`tool`/`input`/`startedAt`/`endedAt` 等字段，不含 `agentId`/`agentLabel`/`sessionId`/`workflowScopePath`。各规则不应重复关联 Session 与 Agent。

### 3.2 类型定义

**新建文件：`src/development/analyzer/types.ts`**

```typescript
import type { ToolCallEvent } from "../../trace/collector.js"
import type { TraceManifest } from "../../trace/types.js"
import type { AgentRecord } from "../../types/index.js"

/** 统一分析事件：ToolCallEvent + Agent/Session 元数据 */
export interface AnalysisToolEvent extends ToolCallEvent {
  /** 所属 Agent 的稳定 ID（runId:callIndex） */
  agentId: string
  /** Agent 显示名 */
  agentLabel: string
  /** 所属 Session ID */
  sessionId: string
  /** 所属 Workflow scope 链 */
  workflowScopePath: string[]
  /** 是否为回放 */
  replayed: boolean
}

/** 证据充分性：原始工具输入/输出/来源是否完整 */
export type EvidenceIntegrity = "complete" | "partial" | "missing"

/** 候选置信度：该证据是否足以支持某项优化建议 */
export type CandidateConfidence = "high" | "medium" | "low"

/** 脚本确定性评估（不靠静态排除，区分三档） */
export type DeterminismAssessment = "likely" | "unknown" | "unlikely"

/** 证据引用（可定位到原始 Trace 的稳定引用） */
export interface EvidenceRef {
  /** 稳定引用：runAttemptId + sessionId + callID */
  runAttemptId: string
  sessionId: string
  callID: string
  /** 展示用元数据 */
  ts: number
  tool: string
  agentLabel: string
  note: string
}

/** 优化候选（对齐 workflow-optimize Skill 第2步输入） */
export interface Proposal {
  /** 单次分析内的唯一标识（runId + category + 签名前 8 字符） */
  id: string
  /** 跨 Run 版本稳定的候选指纹（sha256 of canonical semantic fields） */
  candidateFingerprint: string
  title: string
  description: string
  /** 触发本候选的分析规则 */
  category: "repeat" | "retry" | "dependency" | "latency" | "script-extraction"
  /** 建议修改的 Workflow 或脚本路径 */
  targetPath?: string
  /** 具体优化方向 */
  suggestedChange?: string
  /** 证据引用列表（稳定标识） */
  evidenceRefs: EvidenceRef[]
  /** 证据完整性 */
  evidenceIntegrity: EvidenceIntegrity
  /** 候选置信度 */
  candidateConfidence: CandidateConfidence
  /** 如何验证改动有效（可复算） */
  validationPlan?: string
  /** 预估影响 */
  estimatedImpact: "high" | "medium" | "low"
  /** 生命周期状态 */
  status: "suggested" | "accepted" | "rejected" | "verified"
  /** Script Extraction 专属字段 */
  sourceScript?: string
  suggestedTarget?: string
  observedExecutions?: number
}

/** 五类规则各自的检测结果 */
export interface RuleResults {
  repeats: RepeatObservation[]
  retries: RetryObservation[]
  dependencies: DependencyObservation[]
  latency: LatencyAnalysis
  scriptExtractions: ScriptExtractionCandidate[]
}

/** 重复操作观察事实（Observation，不一定等于优化机会） */
export interface RepeatObservation {
  tool: string
  /** sha256 签名 */
  inputSignature: string
  count: number
  occurrences: Array<{
    ts: number
    agentLabel: string
    callID: string
    sessionId: string
  }>
}

/** 失败重试观察 */
export interface RetryObservation {
  tool: string
  confidence: "confirmed" | "possible"
  failedAt: number
  failedCallID: string
  retryAt: number
  retryCallID: string
  error?: string
  agentLabel: string
  agentId: string
}

/** 顺序依赖观察 */
export interface DependencyObservation {
  chain: Array<{
    ts: number
    tool: string
    agentLabel: string
    callID: string
    filePath?: string
  }>
  chainType: string
}

/** 耗时分析 */
export interface LatencyAnalysis {
  agents: Array<{
    agentId: string
    agentLabel: string
    startedAt: number
    durationMs: number
    /** 从 agent_start 到首个 tool_call 的延迟 */
    firstToolDelayMs: number
    /** Agent 内相邻工具调用的空闲间隔 */
    idleGaps: Array<{ fromCallID: string; toCallID: string; gapMs: number }>
  }>
  totalMs: number
}

/** 脚本固化候选 */
export interface ScriptExtractionCandidate {
  /** 脚本来源工具 */
  sourceTool: "write" | "edit" | "bash"
  /** 脚本内容（edit 工具可能只有片段，无法还原时 scriptContent 为空） */
  scriptContent: string
  /** 创建时记录的文件路径 */
  filePath?: string
  /** 后续执行该脚本的命令关联 */
  executionEvents: AnalysisToolEvent[]
  /** 工具调用 status=completed（不代表业务成功，仅工具层面完成） */
  toolCallCompleted: boolean
  /** 观察到的执行次数 */
  observedExecutions: number
  /** 确定性评估：likely（无 Date.now/Math.random 等非确定性 API）/ unknown（含网络/外部依赖）/ unlikely */
  determinism: DeterminismAssessment
}

/** 分析结果 */
export interface AnalysisResult {
  runId: string
  runAttemptId: string
  ruleResults: RuleResults
  proposals: Proposal[]
  /** 全局证据完整性 */
  overallIntegrity: EvidenceIntegrity
  /** 分析时间戳（外部注入，保证纯函数确定性） */
  generatedAt: number
  /** 分析模式与状态 */
  /** 分析模式：始终为 deterministic（预计算状态用 analysisStatus 区分） */
  analysisMode: "deterministic"
  /** 预计算状态：completed=成功，failed=失败 */
  analysisStatus: "completed" | "failed"
  errorCode?: string
  errorMessage?: string
}
```

### 3.3 适配层

**新建文件：`src/development/analyzer/adapter.ts`**

```typescript
/**
 * 适配层：把 TraceStore 的原始数据合并为 AnalysisToolEvent[]
 *
 * 输入：TraceStore（读 manifest + traces/）+ AgentRecord[]
 * 输出：AnalysisToolEvent[]（每个 event 携带 Agent/Session 元数据）
 *
 * 关联逻辑（只做一次，规则函数不重复）：
 *  1. 从 manifest.sessions 逐 session 读取 traces/<sid>.jsonl
 *  2. 按 sessionId 关联真实 AgentRecord（agent.sessionId === sessionId）
 *     - 缺失 sessionId 的 agent 不参与关联
 *     - AgentRecord 的 startedAt/durationMs 来自真实执行记录，缺失标 unknown（不填造）
 *  3. 把 agentId/agentLabel/workflowScopePath/replayed 注入每个 ToolCallEvent
 *  4. callID 去重：同一 callID 的 pending/running/completed 只保留最终态
 *     （归并逻辑：取 messageIndex + partIndex 最大的那条）
 *     原始 Trace 仍保留状态历史，分析层只消费归并后的事件
 *  5. edit 工具的 input 通常只含修改片段而非完整文件：scriptContent 标记为片段，
 *     evidenceIntegrity 降为 partial（无法还原完整脚本）
 */
export function buildAnalysisEvents(
  store: TraceStore,
  runId: string,
  manifest: TraceManifest,
  agents: AgentRecord[],
): AnalysisToolEvent[]
```

## 四、P3-B：四类规则修正

### 4.1 Rule 1：重复操作检测（修正签名算法）

**修正点**：v1 用 `JSON.stringify(input).slice(0, 200)` 作为签名，长脚本前 200 字符相同会误报。

```typescript
import { createHash } from "node:crypto"

/**
 * 规则 1：重复操作检测
 *
 * 签名 = sha256(tool + ":" + stableStringify(normalizeInput(input)))
 *
 * normalizeInput 只移除确实无关的差异（如序号化的临时文件名后缀），
 * 不能移除文件路径、命令参数或代码内容。
 *
 * 输出 Observation（观察事实），不直接生成 Proposal。
 * 重复读取同一文件不一定多余（中间文件可能已变化）。
 * 只有 LLM 审阅或人工确认后才能提升为优化机会。
 */
export function detectRepeats(events: AnalysisToolEvent[]): RepeatObservation[]

function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  // 浅拷贝，移除纯展示字段（如 metadata），保留 filePath/content/command 等业务字段
  const { metadata, ...rest } = input
  return rest
}

/**
 * 递归稳定序列化：对对象键按字母序排序（包括嵌套对象），
 * 然后对完整序列化结果计算 SHA256。
 *
 * v2 bug 修正：旧实现 JSON.stringify(obj, Object.keys().sort()) 的数组式 replacer
 * 会过滤嵌套对象的属性（只保留 replacer 中列出的键），导致不同对象序列化结果相同。
 */
function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const pairs = keys.map((k) => `"${k}":${stableStringify((obj as Record<string, unknown>)[k])}`)
  return `{${pairs.join(",")}}`
}

function signature(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256").update(`${tool}:${stableStringify(normalizeInput(input))}`).digest("hex").slice(0, 16)
}
```

### 4.2 Rule 2：失败重试链（修正匹配条件）

**修正点**：v1 只要 error 后跟同 tool 就算重试，过于宽松。

```typescript
/**
 * 规则 2：失败重试链
 *
 * 匹配条件（全部满足才标 confirmed）：
 *  1. 同一 Agent 内（agentId 相同）
 *  2. error 调用后 30s 内有同 tool 的 completed 调用
 *  3. 两次调用的 normalizeInput 不完全不同（至少有一个共同 key 的值相同）
 *
 * 不满足条件 3 时标 possible_retry。
 */
export function detectRetries(events: AnalysisToolEvent[]): RetryObservation[]

const RETRY_WINDOW_MS = 30_000
```

### 4.3 Rule 3：顺序依赖链

**修正点**：Dependency 是观察事实，不直接等于优化机会。只有闭环依赖（write→read 链存在且可替代）才生成 Proposal。

```typescript
/**
 * 规则 3：顺序依赖链
 *
 * 从 write/edit 工具的 input.filePath 提取产出路径，
 * 匹配后续 read/bash 工具的 input.filePath/input.command 中的同一路径。
 *
 * 输出 DependencyObservation，不直接生成 Proposal。
 */
export function detectDependencies(events: AnalysisToolEvent[]): DependencyObservation[]
```

### 4.4 Rule 4：耗时分布（修正计算口径）

**修正点**：
1. v1 用 `startedAt - startedAt` 算 gap，应为 `Next.startedAt - Prev.endedAt`
2. v1 跨 Agent 相减，应只在同一 Agent 内分析
3. 不把所有 gap 归类为"LLM 思考"

```typescript
/**
 * 规则 4：耗时分布
 *
 * per-Agent 分析：
 *  1. 各 agent 的 durationMs（from 真实 AgentRecord，缺失标 unknown）
 *  2. agent_start 到首个 tool_call 的延迟
 *  3. Agent 内相邻工具调用的空闲间隔 = Next.startedAt - Prev.endedAt
 *
 * 不跨 Agent 相减（并行 Agent 的工具调用时间线交叠，相减无意义）。
 * gap 只标为"空闲间隔"，不臆测原因（不归类为 LLM 思考/等待/调度）。
 *
 * v3 修正：Latency 是诊断观察，不直接生成 Proposal。
 * 具体瓶颈需要 LLM 审阅或人工确认后才能判定为优化机会。
 */
export function analyzeLatency(events: AnalysisToolEvent[], agents: AgentRecord[]): LatencyAnalysis
```

## 五、P3-C：Rule 5 Script Extraction 候选检测

### 5.1 目标

识别执行轨迹中 Agent 临时创建的脚本（write 工具写入、bash heredoc 内嵌），追踪其后续执行，评估是否可固化为可复用工具。

### 5.2 检测流程

```
Agent 创建或修改脚本 (write/edit input.content 或 bash input.command 含 heredoc)
        |
        v
捕获脚本内容与路径
        |
        v
后续执行命令关联 (同文件路径的 bash 调用)
        |
        v
执行结果和错误 (status + output)
        |
        v
识别可参数化的确定性逻辑
   排除含 Date.now Math.random 等非确定性代码
   排除含硬编码绝对路径的脚本
        |
        v
证据是否充分
   evidenceIntegrity = complete 且 candidateConfidence >= medium
        |
   +----+----+
   |         |
   v         v
  充分      不足
   |         |
   v         v
生成候选   保留观察
```

### 5.3 实现

**新建文件：`src/development/analyzer/script-extraction.ts`**

```typescript
/**
 * Rule 5：Script Extraction 候选检测
 *
 * 识别步骤：
 *  1. 找 write/edit 工具调用，提取 input.content 和 input.filePath
 *     - edit 工具的 input 通常只含修改片段，标记 scriptContent 为片段，evidenceIntegrity 降为 partial
 *  2. 找 bash 工具调用，检测 input.command 中的 heredoc（<<'EOF' 或 <<EOF）
 *  3. 关联后续执行：同 filePath 出现在 bash 的 input.command 中
 *  4. 检查工具调用状态：status = completed（仅代表工具层面完成，不代表业务成功）
 *  5. 确定性评估（不靠静态排除，区分三档）：
 *     - likely：无 Date.now/Math.random/new Date 等非确定性 API，无网络调用关键字
 *     - unknown：含网络/外部依赖/无法判断
 *     - unlikely：含 Date.now/Math.random/new Date
 *
 * TypeScript 规则负责发现"创建→执行"的事实；
 * LLM 负责判断是否值得固化（审阅阶段）；
 * 真正的可复用性通过后续回归测试证明。
 *
 * 输出 ScriptExtractionCandidate[]，满足条件的提升为 Proposal（category = "script-extraction"）
 */
export function detectScriptExtractions(events: AnalysisToolEvent[]): ScriptExtractionCandidate[]

/** 从 bash command 中提取 heredoc 脚本内容 */
function extractHeredoc(command: string): { content: string; language: string } | null

/** 评估脚本确定性（三档，非布尔值） */
function assessDeterminism(scriptContent: string): DeterminismAssessment
```

### 5.4 Proposal 生成条件

只有同时满足以下条件的候选才生成 Proposal：
- `toolCallCompleted === true`（工具调用 status=completed，仅代表工具层面完成）
- `determinism !== "unlikely"`（排除明确含非确定性 API 的脚本）
- `observedExecutions >= 1`（至少被执行一次）
- `evidenceIntegrity !== "missing"`（脚本内容至少部分捕获）

`determinism === "unknown"` 时 candidateConfidence 降为 medium，留给 LLM 审阅判断。

## 六、P3-D：证据与 Proposal Schema

### 6.1 证据评估（拆分两个独立属性）

**新建文件：`src/development/analyzer/evidence.ts`**

```typescript
/**
 * evidenceIntegrity：原始工具输入/输出/来源是否完整
 *
 * complete：input 非空且含核心字段（write 的 content、bash 的 command）
 * partial：input 存在但核心字段部分缺失，或 output 经截断且 outputPath 已过期
 * missing：input 为空对象或核心字段完全缺失
 */
export function assessIntegrity(event: AnalysisToolEvent): EvidenceIntegrity

/**
 * candidateConfidence：该证据是否足以支持某项优化建议
 *
 * high：脚本完整 + 工具调用完成 + determinism=likely
 * medium：脚本完整 + 工具调用完成 + determinism=unknown
 * low：脚本截断 / 工具调用未完成 / determinism=unlikely
 */
export function assessConfidence(
  candidate: ScriptExtractionCandidate,
  integrity: EvidenceIntegrity,
): CandidateConfidence

/** 全局完整性：全部 complete 才 complete，有 missing 则 missing */
export function assessOverallIntegrity(events: AnalysisToolEvent[]): EvidenceIntegrity
```

### 6.2 Proposal 生成

Proposal 只在以下条件满足时生成（规则事实是 Observation，不一定生成 Proposal）：

| 规则 | 生成 Proposal 的条件 | 说明 |
|------|-------------------|------|
| repeat | 不直接生成 Proposal | 重复读取同一文件不一定多余（中间文件可能已变化）。仅输出 Observation，留给 LLM 审阅判断 |
| retry | confidence = confirmed 且 error 可归因 | 重试链有明确证据时可建议加错误处理 |
| dependency | 闭环依赖链存在且可替代（write→read 链可改为 workflow 参数传递） | 需人工确认可替代性 |
| latency | 不直接生成 Proposal | gap 阈值不能证明存在可优化问题。仅输出 LatencyAnalysis 作为诊断观察，留给 LLM 审阅 |
| script-extraction | toolCallCompleted + determinism != unlikely + observedExecutions >= 1 | P3 核心规则，唯一自动生成 Proposal 的规则 |

### 6.3 Proposal 身份与 id 生成

```typescript
/**
 * occurrence ID：单次分析中的唯一标识（runId + category + 签名前 8 字符）
 * 用于本次分析内的去重和引用
 */
function occurrenceId(runId: string, category: string, signature: string): string {
  return `${runId}:${category}:${signature.slice(0, 8)}`
}

/**
 * candidateFingerprint：跨 Run 版本稳定的候选指纹
 * = sha256(category + ":" + stableStringify(canonicalFields))
 * canonicalFields 只含语义稳定字段（tool、filePath、scriptContent 摘要），
 * 不含 runId、ts 等每次变化的字段
 * 用于跨 Run 追踪同一优化候选的演进
 */
function candidateFingerprint(category: string, canonicalFields: Record<string, unknown>): string {
  return createHash("sha256").update(`${category}:${stableStringify(canonicalFields)}`).digest("hex").slice(0, 16)
}
```

### 6.4 报告生成器（纯函数，generatedAt 外部注入）

**新建文件：`src/development/analyzer/report-builder.ts`**

```typescript
/**
 * 从 AnalysisResult 生成 report.md 和 proposals.json（纯函数，无 IO）
 *
 * @param result 分析结果
 * @param generatedAt 外部注入的时间戳（保证相同输入相同输出）
 */
export function buildReport(
  result: AnalysisResult,
  generatedAt: number,
): { reportMd: string; proposalsJson: string }
```

**report.md 结构**：
```markdown
# Development Analysis: <runId>

- Generated: <timestamp>
- Analysis Mode: <deterministic>
- Analysis Status: <completed|failed>
- Overall Evidence Integrity: <complete|partial|missing>
- Proposals: <N>

## Rule 1: Repeat Detection
（Observation 列表，标注"仅观察，不直接生成 Proposal"）

## Rule 2: Retry Chains
（Observation 列表 + confidence 分级）

## Rule 3: Dependency Chains
（Observation 列表 + 链类型）

## Rule 4: Latency Distribution
（per-Agent 耗时 + 空闲间隔 + 标注"仅观察，不直接生成 Proposal"）

## Rule 5: Script Extraction
（候选列表 + determinism 三档评估 + toolCallCompleted + 执行次数）

## Proposals
（优化候选完整信息，含 candidateFingerprint + targetPath/suggestedChange/validationPlan/status）
```

**proposals.json Schema**：
```json
{
  "schemaVersion": 1,
  "runId": "...",
  "generatedAt": 0,
  "proposals": [
    {
      "id": "run-xxx:script-extraction:a1b2c3d4",
      "candidateFingerprint": "e5f6a7b8c9d0e1f2",
      "title": "...",
      "description": "...",
      "category": "script-extraction",
      "targetPath": "scripts/validate-config.py",
      "suggestedChange": "将临时脚本固化为可复用工具",
      "evidenceRefs": [
        { "runAttemptId": "...", "sessionId": "...", "callID": "...", "ts": 0, "tool": "write", "agentLabel": "...", "note": "..." }
      ],
      "evidenceIntegrity": "complete",
      "candidateConfidence": "medium",
      "validationPlan": "固化后用相同输入执行，输出应与历史一致",
      "estimatedImpact": "medium",
      "status": "suggested",
      "sourceScript": "...",
      "suggestedTarget": "scripts/validate-config.py",
      "observedExecutions": 1
    }
  ]
}
```

## 七、P3-E：DevJobManager 预计算

**改动文件：`src/development/job-manager.ts`**

```typescript
private startOptimizer(job: DevJob, input: CreateOnceInput): void {
  // P3: 预计算结构化分析
  let analysisResult: AnalysisResult | undefined
  const generatedAt = Date.now()

  try {
    const store = new TraceStore(input.directory)
    const manifest = store.readManifest(job.originRunId)
    if (!manifest) throw new Error("manifest not found")
    if (manifest.sessions.length === 0) throw new Error("manifest has no sessions")

    // 适配层：合并 ToolCallEvent + Agent 元数据
    // AgentRecord 从真实执行记录获取（AgentJournal），不从 manifest.sessions 填造
    // 缺失字段标 unknown，不编造
    const agents = input.agentJournal?.getAgents() ?? []
    const events = buildAnalysisEvents(store, job.originRunId, manifest, agents)

    // 五类规则
    const ruleResults: RuleResults = {
      repeats: detectRepeats(events),
      retries: detectRetries(events),
      dependencies: detectDependencies(events),
      latency: analyzeLatency(events, agents),
      scriptExtractions: detectScriptExtractions(events),
    }

    // 证据评估 + Proposal 生成（只有 script-extraction 自动生成 Proposal）
    const proposals = buildProposals(job.originRunId, manifest.runAttemptId, ruleResults, events)
    const overallIntegrity = assessOverallIntegrity(events)

    analysisResult = {
      runId: job.originRunId,
      runAttemptId: manifest.runAttemptId,
      ruleResults,
      proposals,
      overallIntegrity,
      generatedAt,
      analysisMode: "deterministic",
      analysisStatus: "completed",
    }

    // 预写 report.md 和 proposals.json
    const report = buildReport(analysisResult, generatedAt)
    store.writeAnalysis(job.originRunId, report.reportMd, report.proposalsJson)
  } catch (e) {
    // 确定性分析失败：记录状态，不静默吞错
    analysisResult = {
      runId: job.originRunId,
      runAttemptId: "",
      ruleResults: { repeats: [], retries: [], dependencies: [], latency: { agents: [], totalMs: 0 }, scriptExtractions: [] },
      proposals: [],
      overallIntegrity: "missing",
      generatedAt,
      analysisMode: "deterministic",
      analysisStatus: "failed",
      errorCode: e instanceof Error ? e.constructor.name : "Unknown",
      errorMessage: e instanceof Error ? e.message : String(e),
    }
    // 不预写报告文件：report.md/proposals.json 不存在
  }

  // ── 分支决策：确定性成功 vs 失败 ──
  const deterministicOk = analysisResult.analysisStatus === "completed"

  if (deterministicOk) {
    // 分支 A：确定性分析成功
    // Optimizer Agent 读取预写报告，只做审阅和增补
    this.startOptimizerReview(job, input, analysisResult, "deterministic-success")
  } else {
    // 分支 B：确定性分析失败
    // 先检查 History 是否可用
    const historyAvailable = this.checkHistoryAvailable(job.originRunId, input.directory)
    if (historyAvailable) {
      // 分支 B1：History 可用，进入独立 LLM 分析分支
      // Optimizer Agent 自行读取 history 进行分析（回退到 P2 模式）
      this.startOptimizerReview(job, input, analysisResult, "llm-fallback")
    } else {
      // 分支 B2：History 不可用，记录失败，不启动缺乏证据的分析
      job.status = "failed"
      job.error = `Deterministic analysis failed and history unavailable: ${analysisResult.errorMessage}`
      job.finishedAt = Date.now()
      this.persist(input.directory)
      return
    }
  }
}

/**
 * 启动 Optimizer 审阅 Run
 * analysisMode 传 "deterministic-success" 或 "llm-fallback"
 * 状态明确区分：预计算状态 vs LLM 分析状态
 */
private startOptimizerReview(
  job: DevJob,
  input: CreateOnceInput,
  analysisResult: AnalysisResult,
  reviewMode: "deterministic-success" | "llm-fallback",
): void {
  const optimizerRunId = this.background.start(
    { client: input.client, parentSessionId: input.parentSessionId, directory: input.directory, rootSessionId: input.rootSessionId },
    {
      script: OPTIMIZER_SCRIPT,
      args: {
        originRunId: job.originRunId,
        historyPath: job.historyPath,
        reviewMode,            // 明确告知 Agent 当前分支
        analysisMode: analysisResult.analysisMode,
        analysisStatus: analysisResult.analysisStatus,
        proposalCount: analysisResult.proposals.length,
        ...(analysisResult.errorMessage ? { analysisError: analysisResult.errorMessage } : {}),
      },
      development: false,
      developmentForbidden: true,
      trigger: { type: "development-optimizer" },
      onFinished: (info) => {
        this.onOptimizerFinished(job.runId, input.directory, info.status, info.error)
      },
    },
  )
  job.optimizerRunId = optimizerRunId
  job.status = "running"
  job.startedAt = Date.now()
  this.persist(input.directory)
}

/** 检查 History 是否可用（history.jsonl 存在且非空） */
private checkHistoryAvailable(runId: string, directory: string): boolean {
  const historyPath = path.join(directory, ".opencode-workflows", "history", runId, "history.jsonl")
  try {
    return fs.existsSync(historyPath) && fs.readFileSync(historyPath, "utf8").trim().length > 0
  } catch {
    return false
  }
}
```

**关键修正（v3）**：
- **分支 A（成功）**：Optimizer 读取预写 report.md/proposals.json，LLM 只做审阅和增补
- **分支 B1（失败+History 可用）**：Optimizer 自行读取 history 进行分析，`reviewMode=llm-fallback` 明确告知 Agent
- **分支 B2（失败+History 不可用）**：记录失败，不启动缺乏证据的分析
- `analysisMode` 记录预计算状态（deterministic），`reviewMode` 记录 LLM 分析模式（deterministic-success/llm-fallback），两者分开
- AgentRecord 从真实执行记录获取，不从 manifest.sessions 填造
- 错误不静默吞：记录 `errorCode`/`errorMessage`

### 7.1 TraceStore 扩展（安全读取移到 Adapter 层）

**改动文件：`src/trace/store.ts`**

```typescript
/** P3: 写入分析报告到 history/<runId>/analysis/ */
writeAnalysis(runId: string, reportMd: string, proposalsJson: string): void {
  const reportPath = path.join(this.runDir(runId), "analysis", "report.md")
  const proposalsPath = path.join(this.runDir(runId), "analysis", "proposals.json")
  this.writeAtomic(reportPath, reportMd)
  this.writeAtomic(proposalsPath, proposalsJson)
}
```

**readToolOutput 移到 Adapter 层（不在 TraceStore 中）**

v3 修正：v2 将 `readToolOutput` 放在通用 `TraceStore` 中，用 `startsWith(projectRoot)` 做安全检查，存在两个问题：
1. OpenCode 的工具输出全文可能保存在宿主专用存储目录（非项目目录内），强制限制在 `projectDir` 下会导致正常 `outputPath` 无法读取
2. 字符串前缀检查不等于安全目录边界检查（如 `/work/project-backup` 也以 `/work/project` 开头）

v3 方案：`readToolOutput` 移到 `OpenCodeSessionAdapter`（唯一允许 import SDK 的位置），在 Adapter 层读取已验证来源的工具输出，然后将受大小限制、脱敏后的内容交给 TraceStore。

**改动文件：`src/adapters/opencode-session-adapter.ts`**

```typescript
/**
 * 安全读取工具输出全文
 *
 * 在 Adapter 层执行，因为 outputPath 的路径归属校验需要了解宿主存储结构。
 * 返回受大小限制（1MB）的内容，调用方（TraceStore/Analyzer）不再直接读文件。
 */
readToolOutput(event: ToolCallEvent): string | null {
  const outputPath = event.metadata?.outputPath
  if (typeof outputPath !== "string" || !outputPath) return null

  try {
    const resolved = path.resolve(outputPath)

    // 路径归属校验：使用 path.relative 判断是否在允许的目录树内
    // 允许的目录：项目目录 + 宿主存储目录（如 ~/.local/share/opencode/）
    const allowedRoots = [
      this.projectDir,
      this.hostStorageDir,  // OpenCode 工具输出存储目录
    ].filter(Boolean)

    const isAllowed = allowedRoots.some((root) => {
      const rel = path.relative(path.resolve(root), resolved)
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
    })
    if (!isAllowed) return null

    // 文件大小限制：1MB
    const stat = fs.statSync(resolved)
    if (stat.size > 1_048_576) return null
    return fs.readFileSync(resolved, "utf8")
  } catch {
    return null
  }
}
```

## 八、P3-F：Optimizer 脚本改进

**改动文件：`src/development/optimizer-script.ts`**

P3 v3 的 Optimizer 脚本接收预计算状态，Agent 仅审阅与增补：

```javascript
export const meta = {
  name: "development_optimizer",
  description: "审阅与增补预计算分析报告",
  phases: [
    { title: "审阅报告" },
    { title: "增补洞察" },
  ],
}

const historyPath = args.historyPath
const analysisPath = historyPath + "/analysis"
const reviewMode = args.reviewMode        // "deterministic-success" | "llm-fallback"
const analysisMode = args.analysisMode    // "deterministic"
const analysisStatus = args.analysisStatus // "completed" | "failed"
const analysisError = args.analysisError  // 失败时的错误信息

phase("审阅报告")

let reviewPrompt
if (reviewMode === "deterministic-success") {
  // 分支 A：确定性分析成功，读取预写报告
  reviewPrompt = "用 read 工具读取 " + analysisPath + "/report.md 和 " + analysisPath + "/proposals.json。" +
    "确定性分析已完成（模式：" + analysisMode + "，状态：" + analysisStatus + "）。" +
    "检查分析是否准确，是否有遗漏的模式或误判。" +
    "用一句话总结审阅结论。"
} else {
  // 分支 B1：确定性分析失败，History 可用，LLM 自行分析
  reviewPrompt = "确定性分析失败（错误：" + (analysisError || "未知") + "）。" +
    "用 read 工具读取 " + historyPath + "/history.md 和 " + historyPath + "/history.jsonl。" +
    "基于 History 数据自行分析 Workflow 执行模式，重点关注：" +
    "1. 临时脚本创建与执行 2. 重复操作 3. 失败重试 4. 耗时分布。" +
    "用一句话总结分析结论。"
}

const review = await agent(reviewPrompt, {
  agentType: "general",
  label: "报告审阅",
})

phase("增补洞察")

// v3 关键修正：将审阅结果 review 传入增补 Agent 的 prompt
// v2 bug：第二个 Agent 的提示词写着"基于审阅结果"但未实际传入 review 变量
const enrichment = await agent(
  "审阅结论：" + (review.result || review) + "\\n\\n" +
  "基于上述审阅结论，用 write 工具在 " + analysisPath + "/ 目录下创建 enrichment.md，" +
  "补充以下内容（如果预计算报告已充分覆盖则写'无需增补'）：\\n" +
  "1. 预计算报告未覆盖的模式或洞察\\n" +
  "2. 对 proposals 的优先级建议\\n" +
  "3. 需要人工确认的风险点\\n" +
  (reviewMode === "llm-fallback"
    ? "4. 基于你刚才的分析，补充基础优化建议\\n"
    : "") +
  "5. 明确标注哪些 Proposal 建议优先实施",
  { agentType: "general", label: "洞察增补" },
)

return { originRunId: args.originRunId, review, enrichment, reviewMode, analysisMode, analysisStatus }
```

## 九、测试计划

### 9.1 单元测试（固定 Trace Fixtures，不依赖 LLM）

**新建文件：`tests/analyzer-fixtures.ts`**

固定 Trace 数据（构造好的 AnalysisToolEvent[]），覆盖各类场景：

```typescript
/** 固定 Trace Fixtures */
export const FIXTURES = {
  /** 两次相同 read（触发 repeat Observation） */
  repeatSameRead: () => AnalysisToolEvent[],
  /** 两次相同 write（触发 repeat Observation + script extraction） */
  repeatSameWrite: () => AnalysisToolEvent[],
  /** error 后同 tool completed（触发 retry confirmed） */
  retryConfirmed: () => AnalysisToolEvent[],
  /** error 后同 tool 但参数不同（触发 retry possible） */
  retryPossible: () => AnalysisToolEvent[],
  /** write 后 read 同文件（触发 dependency） */
  writeReadDependency: () => AnalysisToolEvent[],
  /** write 脚本后 bash 执行（触发 script extraction，determinism=likely） */
  scriptExtraction: () => AnalysisToolEvent[],
  /** bash heredoc 创建脚本（触发 script extraction from heredoc） */
  heredocScript: () => AnalysisToolEvent[],
  /** 含 Date.now 的脚本（determinism=unlikely） */
  nondeterministicScript: () => AnalysisToolEvent[],
  /** 含网络调用的脚本（determinism=unknown） */
  networkScript: () => AnalysisToolEvent[],
  /** edit 工具片段（scriptContent 标记为片段，evidenceIntegrity=partial） */
  editFragment: () => AnalysisToolEvent[],
  /** 并行 Agent 的事件交叠（验证 latency 不跨 Agent） */
  parallelAgents: () => AnalysisToolEvent[],
  /** 含大 gap 的 Agent（验证 latency Observation，含 V-29 断言） */
  latencyGap: () => AnalysisToolEvent[],
  /** 同一 callID 多状态（验证 callID 去重） */
  callIDStates: () => AnalysisToolEvent[],
  /** 空事件列表 */
  empty: () => AnalysisToolEvent[],
}
```

**新建文件：`tests/analyzer-rules.test.ts`**

| 用例 | Fixture | 验证点 |
|------|---------|--------|
| repeat：同 tool 同 input | repeatSameRead | count=2，签名相同（递归 stableStringify） |
| repeat：不同 input 不算重复 | 两次 read 不同文件 | 无重复 |
| repeat：write 同脚本 | repeatSameWrite | count=2 + script extraction |
| repeat：不直接生成 Proposal | repeatSameRead | proposals 中无 repeat 类 |
| retry：confirmed | retryConfirmed | confidence=confirmed |
| retry：possible | retryPossible | confidence=possible |
| retry：超时间窗口 | error 后 31s 才重试 | 不产生链 |
| dependency：write→read 同文件 | writeReadDependency | 链正确 |
| dependency：无关联 | 两次独立 read | 无链 |
| latency：per-Agent gap | parallelAgents | 不跨 Agent 相减 |
| latency：gap 用 endedAt | latencyGap | gap = Next.startedAt - Prev.endedAt |
| latency：不生成 Proposal | latencyGap | proposals 中无 latency 类 |
| callID 去重 | callIDStates | pending/running/completed 只保留最终态 |

**新建文件：`tests/analyzer-script-extraction.test.ts`**

| 用例 | Fixture | 验证点 |
|------|---------|--------|
| write 脚本 + bash 执行 | scriptExtraction | determinism=likely |
| heredoc 脚本 | heredocScript | 从 command 提取 content |
| 含 Date.now 的脚本 | fixture | determinism=unlikely |
| 含网络调用的脚本 | fixture | determinism=unknown |
| 工具调用未完成 | fixture | toolCallCompleted=false，不生成 Proposal |
| edit 工具片段 | fixture | scriptContent 标记为片段，evidenceIntegrity=partial |
| determinism=unknown 的 Proposal | fixture | candidateConfidence=medium（不阻止生成） |

**新建文件：`tests/analyzer-evidence.test.ts`**

| 用例 | 验证点 |
|------|--------|
| write content 完整 | integrity=complete |
| bash command 完整 | integrity=complete |
| output 截断且 outputPath 过期 | integrity=partial |
| input 为空 | integrity=missing |
| 脚本完整+工具调用完成+determinism=likely | confidence=high |
| 脚本完整+工具调用完成+determinism=unknown | confidence=medium |
| 脚本截断/determinism=unlikely | confidence=low |

**新建文件：`tests/analyzer-report.test.ts`**

| 用例 | 验证点 |
|------|--------|
| report.md 含五节规则 | Rule 1-5 标题齐全 |
| report.md Repeat/Latency 标为 Observation | 不含 repeat/latency 类 Proposal |
| proposals.json schemaVersion=1 | 格式正确 |
| proposals.json 每条含 candidateFingerprint | 跨 Run 稳定指纹存在 |
| 相同输入相同输出 | generatedAt 相同时 report 一致 |
| 空 AnalysisResult | 产出最小报告不报错 |
| analysisStatus=failed 时不写 report.md | 分支 B1/B2 处理 |
| analysisStatus=completed 时 report 标注 | 含 Analysis Mode + Analysis Status |

### 9.2 联调验证

**脚本目录**：
```
scripts/
└── p3/
    ├── p3-analyzer-verify.js     P3 主验证：触发五类规则
    ├── p3-child.js               子 Workflow
    └── verify-p3-analysis.ts     P3 结构化分析验证脚本
```

**p3-analyzer-verify.js** 覆盖场景：
- Phase 1: 两次读取同一文件（触发 repeat）
- Phase 2: Agent 写脚本文件（触发 script extraction）
- Phase 3: 子 Workflow（触发 latency 嵌套开销）
- Phase 4: Agent 执行 Phase 2 的脚本（完成 script extraction 闭环 + dependency）

**执行方式**：
```javascript
workflow({ scriptPath: "./scripts/p3/p3-analyzer-verify.js", development: true, background: false })
```

**验证脚本** `verify-p3-analysis.ts` 验证项：

> v3 修正：Optimizer 是独立后台 Workflow，即使业务 Workflow 设 `background: false`，
> 也不意味着后续 Optimizer Job 已完成。验收脚本改为基于 Job 状态等待终态。

```
验收时序：
  业务 Workflow completed
      ↓
  History ready → DevJob created
      ↓
  DevJob status = running（Optimizer 执行中）
      ↓
  轮询 DevJob status 直到 terminal（completed/failed）
      ↓
  检查最终产物与证据
```

验证项：
- DevJob 到达终态（completed 或 failed）
- report.md 含五节规则标题（Rule 1-5）
- proposals.json schemaVersion=1，每条含 candidateFingerprint + category + evidenceRefs + evidenceIntegrity + candidateConfidence
- proposals 至少含 1 条 script-extraction 类候选（如 Agent 按预期执行）
- enrichment.md：仅在 Optimizer Agent 成功完成且确实产生增补内容时才要求存在；若 LLM 审阅失败，确定性报告仍视为有效产物
- manifest development=true
- P1 History 完好性不回归（history.jsonl + history.md + traces/ 完好）
- repeat/latency 类只出现在 report.md 的 Observation 节，不强制生成 Proposal

## 十、验收标准

| 编号 | 验收项 | 验证方式 |
|------|--------|----------|
| V-22 | 五类规则纯函数检测正确（固定 Fixtures） | 单元测试 |
| V-23 | evidenceIntegrity 与 candidateConfidence 独立评估 | 单元测试 |
| V-24 | report.md 含五节规则 + Observation/Proposal 分离 | 联调验证 |
| V-25 | proposals.json schemaVersion=1，每条含 candidateFingerprint + 完整字段 | 联调验证 |
| V-26 | enrichment.md 仅在 Optimizer 成功时存在；失败时确定性报告仍有效 | 联调验证 |
| V-27 | 预计算失败时拆为分支 B1/B2，不盲目启动 Optimizer | 单元测试 |
| V-28 | readToolOutput 在 Adapter 层执行，路径校验用 path.relative 非 startsWith | 单元测试 |
| V-29 | latency 不跨 Agent 相减，gap 用 endedAt，不生成 Proposal | 单元测试 |
| V-30 | retry confirmed vs possible 分级正确 | 单元测试 |
| V-31 | script-extraction 候选含 observedExecutions + determinism 三档 | 单元测试 |
| V-32 | 相同输入相同输出（generatedAt 外部注入） | 单元测试 |
| V-33 | repeat 不直接生成 Proposal（仅 Observation） | 单元测试 |
| V-34 | callID 去重：pending/running/completed 只保留最终态 | 单元测试 |
| V-35 | 联调时等待 DevJob 终态后再检查产物 | 联调验证 |
| V-36 | typecheck + npm test 全量不回归 | CI |

## 十一、P3 v3 执行顺序

```
P3-A  统一 AnalysisToolEvent + callID 去重 + 真实 AgentRecord
      新建 src/development/analyzer/types.ts
      新建 src/development/analyzer/adapter.ts
      新建 tests/analyzer-fixtures.ts
        |
        v
P3-B  四类规则修正（stableStringify 递归 + Repeat/Latency 只出 Observation）
      新建 src/development/analyzer/rules.ts
      新建 tests/analyzer-rules.test.ts（用 Fixtures）
      npm run typecheck && npx tsx --test tests/analyzer-rules.test.ts
        |
        v
P3-C  Script Extraction（determinism 三档 + edit 片段处理）
      新建 src/development/analyzer/script-extraction.ts
      新建 tests/analyzer-script-extraction.test.ts
      npm run typecheck && npx tsx --test tests/analyzer-script-extraction.test.ts
        |
        v
P3-D  证据 + Proposal Schema（含 candidateFingerprint）+ 报告生成
      新建 src/development/analyzer/evidence.ts
      新建 src/development/analyzer/report-builder.ts
      新建 tests/analyzer-evidence.test.ts
      新建 tests/analyzer-report.test.ts
      npm run typecheck && npx tsx --test tests/analyzer-evidence.test.ts tests/analyzer-report.test.ts
        |
        v
P3-E  DevJobManager 预计算 + 分支决策 + readToolOutput 移到 Adapter
      新建 src/development/analyzer/index.ts
      改 src/trace/store.ts（writeAnalysis，移除 readToolOutput）
      改 src/adapters/opencode-session-adapter.ts（新增 readToolOutput）
      改 src/development/job-manager.ts（分支 A/B1/B2）
      npm run typecheck
        |
        v
P3-F  Optimizer 脚本改进（review 变量传入增补 Agent + reviewMode 分支）
      改 src/development/optimizer-script.ts
      npm run typecheck
        |
        v
P3-G  全量验证 + 联调（等待 DevJob 终态）
      npm run typecheck && npm test
      npm run build
      联调验证（dev-examples/development-trace）
```

## 十二、P3 v3 核心验收标准

一次 `development: true` 的 Workflow 执行结束后：
1. 能准确读取父子 Workflow 的完整 History，并生成结构化规则分析
2. 能发现真实创建并执行过的临时脚本，保留原始调用证据
3. 能生成至少一个经过测试数据确认的 Script Extraction 候选，明确来源、建议位置和验证方法
4. 自动触发 Optimizer Job；即使 LLM 分析失败，也保留已有确定性分析结果
5. 生成的 Proposal 能交给 `workflow-optimize` Skill 使用，且不自动修改原 Workflow
6. Repeat/Latency 规则只输出 Observation，不直接生成 Proposal
7. 确定性分析失败时按分支 B1/B2 处理，不盲目启动缺乏证据的 LLM 分析

## 十三、风险与降级方案

| 风险 | 影响 | 降级 |
|------|------|------|
| 预计算失败 | 无预计算报告 | 分支 B1（History 可用→LLM 自行分析）或 B2（不可用→记录失败） |
| readToolOutput 文件已清理 | 无法读全文 | integrity=partial |
| repeat 误报 | Observation 不准确 | Repeat 不直接生成 Proposal，留给 LLM 审阅 |
| retry 误报 | Proposal 不准确 | confirmed/possible 分级 + 时间窗口 |
| heredoc 解析失败 | script extraction 遗漏 | determinism=unknown，confidence=medium |
| edit 片段无法还原 | 脚本内容不完整 | scriptContent 标记片段，evidenceIntegrity=partial |
| LLM 不按预期调用工具 | 联调场景缺失 | 固定 Fixtures 单元测试保证规则正确性 |
| enrichment.md 不存在 | Agent 增补失败 | 预计算报告仍有效（V-26 修正） |
| AgentRecord 缺失 | latency 无 per-Agent 数据 | 缺失字段标 unknown，不填造 |
| outputPath 在宿主存储目录 | TraceStore 无法读取 | readToolOutput 在 Adapter 层执行，支持宿主目录 |

## 十四、引用说明

本执行文档核对的仓库源码位置：

- P0 ToolCallEvent（分析器原始输入）：`src/trace/collector.ts`
- P1 TraceStore（扩展对象）：`src/trace/store.ts`
- P1 TraceManifest（manifest 读取）：`src/trace/types.ts`
- P1 HistoryBuilder（参考模式）：`src/history/builder.ts`
- P2 DevJobManager（预计算接入点）：`src/development/job-manager.ts`
- P2 Optimizer 脚本（改进对象）：`src/development/optimizer-script.ts`
- P2 FinalizerResult（historyPath 来源）：`src/tools/run-finalizer.ts`
- P2 实际产出（proposals.json 样本）：`dev-examples/development-trace/.opencode-workflows/history/run-mv7yivqu/analysis/proposals.json`
- workflow-optimize Skill：`skills/workflow-optimize/SKILL.md`
- optimize-iteration-flow：`skills/workflow-optimize/process/optimize-iteration-flow.md`
- v2 评审修订（P3 范围定义）：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`
- P3 v1 执行文档（被修订对象）：`dev-docs/planning/新增Workflow追踪分析-P3执行文档.md`
- P3 v2 执行文档（v3 修订对象）：`dev-docs/planning/新增Workflow追踪分析-P3执行文档-v2.md`（v2 版本已被本文档 v3 替代）
