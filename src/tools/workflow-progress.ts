/**
 * workflow 进度元数据序列化（F-20 / TUI 增强 MVP-1 前台通道）
 *
 * 数据流（需求文档 Docs/TUI增强需求文档.md 5.1）：
 *  workflow tool 前台执行期
 *   -> onAgentUpdate 维护 records
 *        -> buildProgressMetadata 序列化
 *             -> ToolContext.metadata 推进 ToolPart.state.metadata
 *                  -> TUI 插件 sidebar 读同一形状渲染实时树
 *
 * 完成态走 tool 返回值（prompt.ts:399-411 用 result.metadata 覆盖 state），
 * 因此成功/中断路径的 return 也带同一形状的终态快照。
 *
 * 后台 run 不走本通道（ctx.metadata 在 tool 返回后是闭包过期状态，见需求文档 9.6）。
 */

import type { AgentRecord } from "../types/index.js"

export type WorkflowProgressStatus = "running" | "completed" | "aborted" | "failed"

export interface WorkflowProgressMetadata {
  runId: string
  name?: string
  status: WorkflowProgressStatus
  /** 按 agent 首次出现顺序收集的 phase 列表 */
  phases: string[]
  /** 逐 agent 记录（含 sessionId，running 态即有值） */
  agents: ReadonlyArray<AgentRecord>
  running: number
  completed: number
  failed: number
  total: number
}

/** 从 records 派生 phase 列表（首次出现顺序；无 phase 的 agent 不产生条目） */
export function derivePhases(records: ReadonlyArray<AgentRecord>): string[] {
  const phases: string[] = []
  for (const record of records) {
    if (record.phase && !phases.includes(record.phase)) phases.push(record.phase)
  }
  return phases
}

/** 把 records 快照序列化为 ToolPart metadata（TUI 与 tool 返回值共用同一形状） */
export function buildProgressMetadata(input: {
  runId: string
  name?: string
  status: WorkflowProgressStatus
  records: ReadonlyArray<AgentRecord>
}): WorkflowProgressMetadata {
  const running = input.records.filter((r) => r.status === "running").length
  const completed = input.records.filter((r) => r.status === "ok").length
  const failed = input.records.filter((r) => r.status === "failed").length
  return {
    runId: input.runId,
    ...(input.name ? { name: input.name } : {}),
    status: input.status,
    phases: derivePhases(input.records),
    agents: input.records,
    running,
    completed,
    failed,
    total: input.records.length,
  }
}
