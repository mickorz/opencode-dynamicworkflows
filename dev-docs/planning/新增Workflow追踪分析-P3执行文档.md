# P3 执行文档 - Analyzer 四类规则 + Skill 集成

> 本文件是 Development Trace & History 功能 P3 阶段的详细执行计划。
> 基线：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`，P0/P1/P2 已完成并验证通过。
>
> P3 目标：将 P2 的 LLM 驱动分析替换为结构化 TypeScript 代码分析（四类规则），
> 产出确定性、可复算的分析报告与优化候选，并与 workflow-optimize Skill 对接。
>
> P3 不实现自动改写原 Workflow 脚本（第一版禁止）。

## 类头流程图：P3 分析闭环

```
 P3 从 History 到结构化分析报告的完整流程

 DevJobManager createOnce
        |
        v
 读取 History 文件
   manifest json
   history jsonl ToolCallEvent 数组
        |
        v
 结构化分析器 四类规则 纯 TypeScript 代码
   规则1 重复操作检测
     同 tool 同 input 多次出现
   规则2 失败重试链
     status error 后跟同 tool 重试
   规则3 顺序依赖链
     write 产物被后续 read 消费
   规则4 耗时分布
     wall clock per agent per phase per gap
        |
        v
 证据充分性标记
   full write input content 完整
   partial bash heredoc 需解析
   low input 缺失或不可靠
        |
        v
 生成 report md proposals json 纯函数
        |
        v
 Optimizer Agent 审阅与增补 可选 LLM 层
   读取预计算结果
   增补人类可读洞察
   写入 analysis 目录
        |
        v
 Skill 集成
   proposals json 格式对齐 workflow optimize skill
   供 skill 第2步设计改动消费
```

## 一、P3 范围与交付物

| 子项 | 内容 | 依赖 |
|------|------|------|
| 结构化分析器 | 四类规则纯函数实现 | P1 TraceStore + history.jsonl |
| 证据充分性标记 | full/partial/low 三级评估 | P1 ToolCallEvent.input |
| 报告生成器 | 纯函数生成 report.md + proposals.json | 分析器结果 |
| DevJobManager 预计算 | startOptimizer 前先跑分析器 | 分析器 + TraceStore |
| Optimizer 脚本改进 | 接收预计算结果，Agent 仅审阅增补 | P2 optimizer-script |
| TraceStore 扩展 | readToolOutput 读 outputPath 全文 | P1 TraceStore |
| Skill 对齐 | proposals.json 格式对齐 workflow-optimize | P2 proposals |
| 测试脚本 | p3/ 联调脚本 + 单元测试 | 全部 |

## 二、模块结构

```
src/
├── development/
│   ├── analyzer/                    # P3 新增：结构化分析
│   │   ├── types.ts                 # AnalysisResult / Proposal / EvidenceRef / EvidenceSufficiency
│   │   ├── rules.ts                  # 四类规则纯函数
│   │   ├── evidence.ts               # 证据充分性评估
│   │   └── report-builder.ts         # 生成 report.md + proposals.json（纯函数）
│   ├── job-manager.ts                # P3 改动：startOptimizer 前预计算分析
│   ├── optimizer-script.ts           # P3 改动：接收预计算 args，Agent 仅审阅
│   └── types.ts
├── trace/
│   └── store.ts                      # P3 扩展：readToolOutput 读 outputPath
```

架构约束（AGENTS.md）：
- `src/development/analyzer/` 禁止 import SDK——纯 TypeScript 纯函数
- 分析器消费 `ToolCallEvent[]` 和 `TraceManifest`，产出 `AnalysisResult`
- 报告生成器是纯函数，无 IO（写入由 DevJobManager 负责）
- 不使用 console.log/error（CLAUDE.md 约束）

## 三、结构化分析器

### 3.1 类型定义

**新建文件：`src/development/analyzer/types.ts`**

```typescript
/** 证据充分性级别 */
export type EvidenceSufficiency = "full" | "partial" | "low"

/** 证据引用（指向 history.jsonl 中的具体事件） */
export interface EvidenceRef {
  ts: number
  tool?: string
  agentLabel?: string
  note: string
}

/** 优化候选 */
export interface Proposal {
  /** 短标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 触发本候选的分析规则 */
  category: "repeat" | "retry" | "dependency" | "latency"
  /** 证据引用列表 */
  evidence: EvidenceRef[]
  /** 证据充分性 */
  evidenceSufficiency: EvidenceSufficiency
  /** 预估影响 */
  estimatedImpact: "high" | "medium" | "low"
}

/** 四类规则各自的检测结果 */
export interface RuleResults {
  repeats: RepeatDetection[]
  retries: RetryChain[]
  dependencies: DependencyChain[]
  latency: LatencyAnalysis
}

/** 重复操作检测 */
export interface RepeatDetection {
  tool: string
  /** 重复的 input 签名（JSON 字符串的 hash） */
  inputSignature: string
  /** 重复次数 */
  count: number
  /** 各次调用的 ts + agentLabel */
  occurrences: Array<{ ts: number; agentLabel: string; callID: string }>
}

/** 失败重试链 */
export interface RetryChain {
  tool: string
  /** 失败调用的 ts + callID */
  failedAt: number
  failedCallID: string
  /** 重试调用的 ts + callID */
  retryAt: number
  retryCallID: string
  /** 失败原因 */
  error?: string
  /** agentLabel */
  agentLabel: string
}

/** 顺序依赖链 */
export interface DependencyChain {
  /** 链中的工具调用序列 */
  chain: Array<{
    ts: number
    tool: string
    agentLabel: string
    /** 关联的文件路径 */
    filePath?: string
  }>
  /** 链类型推断 */
  chainType: string
}

/** 耗时分布分析 */
export interface LatencyAnalysis {
  /** 各 agent 的耗时 */
  agents: Array<{
    agentLabel: string
    startedAt: number
    durationMs: number
    /** 从 agent_start 到首个 tool_call 的延迟 */
    firstToolDelayMs: number
  }>
  /** 相邻工具调用之间的 gap */
  gaps: Array<{
    from: { ts: number; tool: string; agentLabel: string }
    to: { ts: number; tool: string; agentLabel: string }
    gapMs: number
  }>
  /** 最慢段 */
  slowestGap?: { description: string; gapMs: number }
  /** 总耗时 */
  totalMs: number
}

/** 分析结果 */
export interface AnalysisResult {
  runId: string
  ruleResults: RuleResults
  proposals: Proposal[]
  /** 全局证据充分性 */
  overallSufficiency: EvidenceSufficiency
  generatedAt: number
}
```

### 3.2 四类规则实现

**新建文件：`src/development/analyzer/rules.ts`**

四类规则均为纯函数，输入 `ToolCallEvent[]` + `AgentRecord[]`，输出各自的检测结果。

```typescript
/**
 * 规则 1：重复操作检测
 *
 * 按 tool + input 签名分组，count > 1 的组为重复。
 * input 签名 = JSON.stringify(input) 的前 200 字符（防超长 input 拖慢 hash）。
 */
export function detectRepeats(events: ToolCallEvent[]): RepeatDetection[]

/**
 * 规则 2：失败重试链
 *
 * 找 status="error" 的 ToolCallEvent，检查同 agent 内后续是否有同 tool 的 completed 调用。
 */
export function detectRetries(events: ToolCallEvent[], agents: AgentRecord[]): RetryChain[]

/**
 * 规则 3：顺序依赖链
 *
 * 从 write/edit 工具的 input.filePath 提取产出文件路径，
 * 匹配后续 read/bash 工具的 input.filePath/input.command 中的同一路径。
 */
export function detectDependencies(events: ToolCallEvent[]): DependencyChain[]

/**
 * 规则 4：耗时分布
 *
 * 从 AgentRecord 的 startedAt + durationMs 计算各 agent 耗时，
 * 从 ToolCallEvent 的 startedAt 计算相邻 gap，找最慢段。
 */
export function analyzeLatency(events: ToolCallEvent[], agents: AgentRecord[]): LatencyAnalysis
```

**实现要点**：
- `detectRepeats`：对 `input` 做 `JSON.stringify` 后取前 200 字符作为签名，按 `tool + 签名` 分组
- `detectRetries`：按 `agentId` 分组 events，在组内找 `error` 后跟 `completed` 的同 `tool` 对
- `detectDependencies`：从 `write` 工具的 `input.filePath` 提取路径，在后续 `read`/`bash` 的 `input.filePath`/`input.command` 中匹配
- `analyzeLatency`：从 `AgentRecord.startedAt` + `durationMs` 算各 agent 耗时；从 `ToolCallEvent.startedAt` 算相邻 gap

### 3.3 证据充分性评估

**新建文件：`src/development/analyzer/evidence.ts`**

```typescript
/**
 * 评估单个 ToolCallEvent 的证据充分性
 *
 * full：write/edit 工具的 input.content 含完整脚本（> 50 字符）
 * partial：bash 工具的 input.command 含 heredoc（<< 或 <<'EOF'），可解析但更难
 * low：input 为空对象或关键字段缺失
 */
export function assessEvidence(event: ToolCallEvent): EvidenceSufficiency

/**
 * 评估整个 Run 的证据充分性
 *
 * 全部 full → full
 * 有 partial 无 low → partial
 * 有 low → low
 */
export function assessOverall(events: ToolCallEvent[]): EvidenceSufficiency
```

### 3.4 报告生成器

**新建文件：`src/development/analyzer/report-builder.ts`**

```typescript
/**
 * 从 AnalysisResult 生成 report.md 和 proposals.json（纯函数，无 IO）
 */
export function buildReport(result: AnalysisResult): {
  reportMd: string
  proposalsJson: string
}
```

**report.md 结构**：
```markdown
# Development Analysis: <runId>

- Generated: <timestamp>
- Evidence Sufficiency: <full/partial/low>
- Proposals: <N>

## Execution Summary
- Total Duration: <ms>
- Agents: <N>
- Tool Calls: <N>

## Rule 1: Repeat Detection
（列出检测到的重复操作）

## Rule 2: Retry Chains
（列出失败重试链）

## Rule 3: Dependency Chains
（列出顺序依赖链）

## Rule 4: Latency Distribution
（列出各 agent 耗时 + gap 分布 + 最慢段）

## Proposals
（列出优化候选，含 title/description/category/evidence/impact）
```

**proposals.json 格式**（对齐 workflow-optimize Skill）：
```json
[
  {
    "title": "...",
    "description": "...",
    "category": "repeat|retry|dependency|latency",
    "evidence": [{ "ts": 0, "tool": "...", "agentLabel": "...", "note": "..." }],
    "evidenceSufficiency": "full|partial|low",
    "estimatedImpact": "high|medium|low"
  }
]
```

### 3.5 分析入口函数

**新建文件：`src/development/analyzer/index.ts`**

```typescript
/**
 * 分析入口：读 History 文件 → 跑四类规则 → 生成报告
 *
 * DevJobManager 调用此函数预计算分析结果，传入 Optimizer 的 args。
 */
export function analyzeRun(
  store: TraceStore,
  runId: string,
  agents: AgentRecord[],
  sessionEvents: Array<{ sessionId: string; agentId: string; events: ToolCallEvent[] }>,
  manifest: TraceManifest,
): AnalysisResult
```

此函数：
1. 从 `store` 读取 `manifest.json`
2. 合并各 session 的 `ToolCallEvent[]`
3. 跑四类规则
4. 评估证据充分性
5. 生成 proposals（从 ruleResults 推导）
6. 返回 `AnalysisResult`

## 四、DevJobManager 预计算

**改动文件：`src/development/job-manager.ts`**

`startOptimizer` 方法改为：

```typescript
private startOptimizer(job: DevJob, input: CreateOnceInput): void {
  // P3: 预计算结构化分析
  let analysisSummary: string | undefined
  try {
    const store = new TraceStore(input.directory)
    const manifest = store.readManifest(job.originRunId)
    // 读取各 session 的 trace events
    const sessionEvents = manifest?.sessions
      ?.filter((s) => !s.replayed && s.sessionId)
      .map((s) => ({
        sessionId: s.sessionId,
        agentId: s.agentId,
        events: store.readSessionTrace(job.originRunId, s.sessionId!),
      })) ?? []
    const agents = /* 从 manifest 或 jobs.json 获取 */
    if (manifest && sessionEvents.length > 0) {
      const result = analyzeRun(store, job.originRunId, agents, sessionEvents, manifest)
      // 预写 report.md 和 proposals.json
      const report = buildReport(result)
      store.writeAnalysis(job.originRunId, report.reportMd, report.proposalsJson)
    }
  } catch {
    // 预计算失败不阻断，Optimizer Agent 自行分析
  }

  // 启动 Optimizer Run（args 带预计算摘要）
  const optimizerRunId = this.background.start(...)
}
```

**TraceStore 扩展**：

```typescript
/** P3: 写入分析报告 */
writeAnalysis(runId: string, reportMd: string, proposalsJson: string): void {
  // 写入 history/<runId>/analysis/report.md 和 proposals.json
}

/** P3: 读取工具输出全文（从 metadata.outputPath） */
readToolOutput(event: ToolCallEvent): string | null {
  const outputPath = event.metadata?.outputPath as string
  if (!outputPath) return null
  try { return fs.readFileSync(outputPath, "utf8") } catch { return null }
}
```

## 五、Optimizer 脚本改进

**改动文件：`src/development/optimizer-script.ts`**

P2 的 Optimizer 脚本用 3 个 Agent 读取 History、分析、生成报告。
P3 改为：DevJobManager 预计算分析结果并写入 analysis/ 目录，Optimizer 脚本仅用 Agent 审阅与增补。

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

phase("审阅报告")
const review = await agent(
  "用 read 工具读取 " + analysisPath + "/report.md 和 " + analysisPath + "/proposals.json，" +
  "检查分析是否准确，是否有遗漏的模式或误判。用一句话总结审阅结论。",
  { agentType: "general", label: "报告审阅" },
)

phase("增补洞察")
const enrichment = await agent(
  "基于审阅结果，用 write 工具在 " + analysisPath + "/ 目录下创建 enrichment.md，" +
  "补充以下内容（如果预计算报告已充分覆盖则写'无需增补'）：\\n" +
  "1. 预计算报告未覆盖的模式或洞察\\n" +
  "2. 对 proposals 的优先级建议\\n" +
  "3. 需要人工确认的风险点",
  { agentType: "general", label: "洞察增补" },
)

return { originRunId: args.originRunId, review, enrichment }
```

**关键改进**：
- 报告生成由 TypeScript 代码完成（确定性、可复算）
- Agent 仅做审阅与增补（可选层，失败不影响报告已有）
- 预计算失败时 Optimizer 回退到 P2 模式（Agent 自行分析）

## 六、Skill 集成

### 6.1 proposals.json 格式对齐

workflow-optimize Skill 的 `optimize-iteration-flow.md` 第 2 步要求"改动清单表"：

| # | 改动 | 位置 | 修复的问题 | 预期验证方式 |

P3 的 proposals.json 每条候选可映射到此表的输入：
- `title` → 改动
- `description` → 修复的问题 + 预期验证方式
- `evidence` → 证明问题存在的事件引用
- `estimatedImpact` → 优先级参考

### 6.2 Skill 路径注册

dev-examples 的 `opencode.json` 已注册 `skills.paths`：

```json
{
  "skills": { "paths": ["../../skills"] }
}
```

用户可在对话中引用 workflow-optimize skill，消费 proposals.json：

```
@workflow-optimize
请基于 .opencode-workflows/history/<runId>/analysis/proposals.json
设计下一版改动
```

### 6.3 不自动触发 Skill

P3 不自动调用 Skill（需要人工审核 proposals 后再决定是否优化）。
自动触发 Skill 是 P4+ 范围（需用户配置 + 人工确认通道）。

## 七、测试计划

### 7.1 单元测试

**新建文件：`tests/analyzer-rules.test.ts`**

| 用例 | 验证点 |
|------|--------|
| detectRepeats：同 tool 同 input 出现 2 次 | count=2，occurrences 有 2 条 |
| detectRepeats：不同 input 不算重复 | count=1 的组被过滤 |
| detectRetries：error 后跟同 tool completed | 链正确识别 |
| detectRetries：error 后无重试 | 不产生链 |
| detectDependencies：write 产物被后续 read 消费 | 链正确识别 |
| detectDependencies：无关联的 read/write 不产生链 | 不误报 |
| analyzeLatency：各 agent 耗时正确 | durationMs 一致 |
| analyzeLatency：gap 计算正确 | 相邻事件 gap 准确 |
| analyzeLatency：slowestGap 正确 | 最大 gap 被识别 |

**新建文件：`tests/analyzer-evidence.test.ts`**

| 用例 | 验证点 |
|------|--------|
| write 工具 input.content > 50 字符 | sufficiency = full |
| bash 工具 input.command 含 heredoc | sufficiency = partial |
| input 为空对象 | sufficiency = low |
| 整体评估：全部 full | overall = full |
| 整体评估：有 partial 无 low | overall = partial |

**新建文件：`tests/analyzer-report.test.ts`**

| 用例 | 验证点 |
|------|--------|
| report.md 含标题 + 四节规则 + proposals | 段齐全 |
| proposals.json 可解析且含 proposals 数组 | JSON 格式正确 |
| 空 AnalysisResult 不报错 | 产出最小报告 |

### 7.2 联调验证

在 `dev-examples/development-trace/` 启动 opencode，运行：

```javascript
workflow({ scriptPath: "./scripts/p3/p3-analyzer-verify.js", development: true, background: false })
```

验证：
1. `analysis/report.md` 含四节规则（重复/重试/依赖/耗时）
2. `analysis/proposals.json` 每条含 category + evidence + evidenceSufficiency
3. `analysis/enrichment.md` 存在（Agent 增补）
4. 预计算报告与 P2 LLM 报告对比：关键结论一致但更精确

## 八、测试脚本

### 8.1 脚本目录结构

```
scripts/
├── p0/                              ← P0 脚本（已完成）
├── p1/                              ← P1 脚本（已完成）
├── p2/                              ← P2 脚本（已完成）
└── p3/                              ← P3 脚本（新增）
    ├── p3-analyzer-verify.js         P3 主验证：触发四类分析规则
    ├── p3-child.js                   P3 子 Workflow
    └── verify-p3-analysis.ts         P3 结构化分析验证脚本
```

### 8.2 P3 测试脚本说明

**p3-analyzer-verify.js** — P3 主验证 Workflow

覆盖场景（触发四类规则）：
- Phase 1: Agent 读取同一文件两次（触发重复操作检测）
- Phase 2: Agent 写文件，后续 Agent 读取该文件（触发顺序依赖链）
- Phase 3: 子 Workflow（触发耗时分布 + 嵌套开销分析）
- Phase 4: Agent 运行命令验证（完成依赖链闭环）

执行方式：
```javascript
workflow({ scriptPath: "./scripts/p3/p3-analyzer-verify.js", development: true, background: false })
```

**p3-child.js** — P3 子 Workflow

被 p3-analyzer-verify.js 调用，Agent 读取文件，供耗时分析规则使用。

**verify-p3-analysis.ts** — P3 验证脚本

验证项：
- `analysis/report.md` 含四节规则标题（Rule 1-4）
- `analysis/proposals.json` 每条含 category + evidence + evidenceSufficiency
- `analysis/enrichment.md` 存在且非空
- proposals 的 category 覆盖至少 2 种（dependency + latency 必有）
- P1 History 完好性不回归

执行方式：
```bash
npx tsx scripts/p3/verify-p3-analysis.ts <runId>
```

### 8.3 联调步骤

1. 编译插件：`npm run build`
2. 启动 opencode
3. 执行 P3 Workflow：
   ```javascript
   workflow({ scriptPath: "./scripts/p3/p3-analyzer-verify.js", development: true, background: false })
   ```
4. 拿到 runId 后验证：
   ```bash
   npx tsx scripts/p3/verify-p3-analysis.ts <runId>
   ```

## 九、验收标准

| 编号 | 验收项 | 验证方式 |
|------|--------|----------|
| V-22 | 四类规则纯函数检测正确 | 单元测试 |
| V-23 | 证据充分性标记正确 | 单元测试 |
| V-24 | report.md 含四节规则 + proposals 段 | 联调验证 |
| V-25 | proposals.json 每条含 category + evidence + sufficiency | 联调验证 |
| V-26 | enrichment.md 存在且非空 | 联调验证 |
| V-27 | 预计算失败时 Optimizer 回退到 LLM 分析 | 联调验证（破坏 manifest 测试） |
| V-28 | readToolOutput 能读 outputPath 全文 | 单元测试 |
| V-29 | proposals 的 category 覆盖 dependency + latency | 联调验证 |
| V-30 | typecheck + npm test 全量不回归 | CI |

## 十、执行顺序

```
第一步  类型定义
        新建 src/development/analyzer/types.ts
          |
          v
第二步  四类规则实现
        新建 src/development/analyzer/rules.ts
        新建 tests/analyzer-rules.test.ts
        npm run typecheck && npx tsx --test tests/analyzer-rules.test.ts
          |
          v
第三步  证据充分性
        新建 src/development/analyzer/evidence.ts
        新建 tests/analyzer-evidence.test.ts
        npm run typecheck && npx tsx --test tests/analyzer-evidence.test.ts
          |
          v
第四步  报告生成器
        新建 src/development/analyzer/report-builder.ts
        新建 tests/analyzer-report.test.ts
        npm run typecheck && npx tsx --test tests/analyzer-report.test.ts
          |
          v
第五步  分析入口 + TraceStore 扩展
        新建 src/development/analyzer/index.ts
        改 src/trace/store.ts（writeAnalysis + readToolOutput）
        npm run typecheck
          |
          v
第六步  DevJobManager 预计算 + Optimizer 脚本改进
        改 src/development/job-manager.ts
        改 src/development/optimizer-script.ts
        npm run typecheck
          |
          v
第七步  测试脚本
        新建 scripts/p3/p3-analyzer-verify.js
        新建 scripts/p3/p3-child.js
        新建 scripts/p3/verify-p3-analysis.ts
          |
          v
第八步  全量验证
        npm run typecheck && npm test
        npm run build
        联调验证（dev-examples/development-trace）
```

## 十一、P2 与 P3 对比

| 维度 | P2（LLM 驱动） | P3（结构化代码） |
|------|---------------|----------------|
| 分析方式 | Agent 读 history.md，LLM 推理 | TypeScript 纯函数解析 history.jsonl |
| 确定性 | 不确定（LLM 每次分析不同） | 确定（相同输入相同输出） |
| 证据引用 | LLM 自由引用 ts + tool | 代码精确引用，格式固定 |
| 证据充分性 | 无标记 | full/partial/low 三级 |
| 报告质量 | 依赖 LLM 能力 | 基础由代码保证，LLM 增补 |
| 耗时 | 3 Agent ~163s | 预计算 <1s + 2 Agent 审阅 ~30s |
| 可复算 | 不可复算 | 可复算（相同输入相同输出） |
| Skill 对齐 | 格式不固定 | proposals.json 格式对齐 |

## 十二、风险与降级方案

| 风险 | 影响 | 降级 |
|------|------|------|
| 预计算失败（manifest 损坏） | 无预计算报告 | Optimizer 回退到 P2 LLM 模式 |
| readToolOutput 文件已被清理 | 无法读全文 | 标 evidenceSufficiency = low |
| 规则误报 | proposals 不准确 | Agent 审阅层过滤；人工审核 |
| heredoc 解析失败 | dependency 链断裂 | 标 partial，附原因 |
| enrichment.md 不存在 | Agent 增补失败 | 预计算报告仍可用 |

## 十三、引用说明

本执行文档核对的仓库源码位置：

- P2 DevJobManager（预计算接入点）：`src/development/job-manager.ts`
- P2 Optimizer 脚本（改进对象）：`src/development/optimizer-script.ts`
- P1 TraceStore（扩展对象）：`src/trace/store.ts`
- P1 ToolCallEvent（分析器输入）：`src/trace/collector.ts`
- P1 TraceManifest（manifest 读取）：`src/trace/types.ts`
- P1 HistoryBuilder（参考模式）：`src/history/builder.ts`
- P2 FinalizerResult（historyPath 来源）：`src/tools/run-finalizer.ts`
- workflow-optimize Skill：`skills/workflow-optimize/SKILL.md`
- optimize-playbook：`skills/workflow-optimize/reference/optimize-playbook.md`
- ledger-schema：`skills/workflow-optimize/reference/ledger-schema.md`
- optimize-iteration-flow：`skills/workflow-optimize/process/optimize-iteration-flow.md`
- v2 评审修订（P3 范围定义）：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`
- P2 执行文档（前置阶段）：`dev-docs/planning/新增Workflow追踪分析-P2执行文档.md`
- P2 实际产出（proposals.json 样本）：`dev-examples/development-trace/.opencode-workflows/history/run-mv7yivqu/analysis/proposals.json`
