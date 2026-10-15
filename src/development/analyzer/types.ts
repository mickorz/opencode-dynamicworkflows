/**
 * P3 Analyzer 类型定义
 *
 * 统一分析事件模型 + 五类规则结果类型 + 优化候选 Schema + 分析结果
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 *
 * AnalysisToolEvent 适配层将 ToolCallEvent 与 AgentRecord 合并：
 *
 * ToolCallEvent (P0)          AgentRecord (runtime)
 *   callID                      id
 *   tool                        label
 *   status                      workflowScopePath
 *   input/output                sessionId
 *   startedAt/endedAt           replayed
 *        \                       /
 *         --> AnalysisToolEvent <--
 *               agentId
 *               agentLabel
 *               sessionId
 *               workflowScopePath
 *               replayed
 */

import type { ToolCallEvent } from "../../trace/collector.js"

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

/** 重复操作观察事实（Observation，不直接生成 Proposal） */
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

/** 耗时分析（Observation，不直接生成 Proposal） */
export interface LatencyAnalysis {
  agents: Array<{
    agentId: string
    agentLabel: string
    startedAt: number
    durationMs: number | "unknown"
    /** 从 agent_start 到首个 tool_call 的延迟 */
    firstToolDelayMs: number | "unknown"
    /** Agent 内相邻工具调用的空闲间隔 = Next.startedAt - Prev.endedAt */
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
  /** 确定性评估：likely / unknown / unlikely */
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
  /** 分析模式：始终为 deterministic（预计算状态用 analysisStatus 区分） */
  analysisMode: "deterministic"
  /** 预计算状态：completed=成功，failed=失败 */
  analysisStatus: "completed" | "failed"
  errorCode?: string
  errorMessage?: string
}
