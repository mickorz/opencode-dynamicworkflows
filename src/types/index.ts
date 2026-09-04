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

/** journal 条目：key 为 runId:callIndex，hash 覆盖 prompt/model/phase/agentType/schema（P1-1） */
export interface JournalEntry {
  hash: string
  result: unknown
  model?: string
}
