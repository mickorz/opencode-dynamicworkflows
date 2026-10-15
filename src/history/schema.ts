/**
 * History 形状定义（P1）
 *
 * history.jsonl 每行的形状（全局时间线事件）
 * history.md 的段结构
 *
 * 宿主无关：纯类型定义
 */

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

/** HistoryBuilder 的输出 */
export interface HistoryBuildResult {
  /** 机器可读的全局时间线（JSONL） */
  jsonl: string
  /** 人与 LLM 可读的整理视图（Markdown） */
  md: string
}
