/**
 * 共享类型定义
 */

/** 单个 agent 的 token 用量（由 Adapter 从 prompt 响应中提取） */
export interface AgentUsage {
  input?: number
  output?: number
  total?: number
  /** 该次调用的货币成本（provider 上报时才有，美元） */
  cost?: number
}

/** agent 记录状态 */
export type AgentRecordStatus = "running" | "ok" | "failed" | "aborted"

/** token 用量拆分（Node Inspector 展示用） */
export interface AgentUsageSplit {
  inputTokens?: number
  outputTokens?: number
}

/**
 * 单次真实执行记录（FR-7）：executionId = runId:callIndex:attempt。
 * retry 的每个 attempt 一条；journal 回放不产生新执行。
 */
export interface AgentExecutionRecord {
  executionId: string
  /** 尝试序号，1 起算 */
  attempt: number
  status: "ok" | "failed" | "aborted"
  label?: string
  sessionId?: string
  error?: string
  startedAt?: number
  durationMs?: number
  usage?: AgentUsageSplit
}

/** 单个 agent 的执行记录（用于 F-07 汇总返回） */
export interface AgentRecord {
  /** 形如 runId:callIndex 的稳定标识 */
  id: string
  label: string
  phase?: string
  status: AgentRecordStatus
  tokens?: number
  cost?: number
  error?: string
  durationMs?: number
  /** resume 时从 journal 免费回放（未真实调 LLM） */
  replayed?: boolean
  model?: string
  /** 本次调用的子会话 ID（adapter 建会话后立即回填；F-20 TUI 进子会话用；journal 回放的 agent 无此字段） */
  sessionId?: string
  // ---- Node Inspector 扩展（全部可选；老快照/metadata 无这些字段，读端宽松）----
  /** 最新一次真实执行的标识（runId:callIndex:attempt）；journal 回放时从 entry 恢复 */
  executionId?: string
  /** 最后一次尝试的序号（1 起算） */
  attempt?: number
  /** 结果形态（text / structured）；journal 回放时从 entry.outputType 恢复 */
  outputType?: "text" | "structured"
  /** 结果 2KB 截断预览（已脱敏）；完整内容只在 journal，Node Detail 兜底用 */
  outputPreview?: string
  inputTokens?: number
  outputTokens?: number
}

/** workflow 脚本 meta 信封 */
export interface WorkflowMeta {
  name: string
  description?: string
  phases?: Array<{ title: string }>
}

/** runWorkflow 的返回值 */
export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta
  /** 脚本 return 的值 */
  result: T
  logs: string[]
  phases: string[]
  agents: AgentRecord[]
  agentCount: number
  durationMs: number
  runId: string
}

/** journal 条目：key 为 runId:callIndex，hash 覆盖 prompt/model/phase/agentType/schema（P1-1）
 *  Node Inspector 扩展字段（全部可选，老 journal 无这些字段，读端宽松）：
 *  hash/result 仅在 agent 成功时写入（resume 语义不变）；失败 attempt 只进 executions，绝不写 hash。 */
export interface JournalEntry {
  hash: string
  result: unknown
  model?: string
  label?: string
  phase?: string
  agentType?: string
  /** 原始 prompt（4KB 截断，仅展示用；不参与 hash 身份） */
  prompt?: string
  sessionId?: string
  outputType?: "text" | "structured" | "unknown"
  executionId?: string
  attempt?: number
  startedAt?: number
  durationMs?: number
  usage?: AgentUsageSplit
  /** 历次尝试记录（追加式，保留最近 10 条；最后一条即最新执行；绝不影响 resume） */
  executions?: AgentExecutionRecord[]
}
