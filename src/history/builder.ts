/**
 * HistoryBuilder —— 合并执行树与全局时间线（P1）
 *
 * 输入：AgentRecord 数组 + WorkflowExecutionRecord + 各 session 的 ToolCallEvent
 * 输出：history.jsonl（机器可读时间线） + history.md（人可读整理视图）
 *
 * 纯函数，无 IO（写入由 RunFinalizer 负责）。
 * 宿主无关：不依赖 SDK。
 *
 * 事件序列：
 *  1. Workflow 执行树事件（workflow_start / workflow_end）
 *  2. Agent 事件（agent_start / agent_end）
 *  3. 工具调用事件（tool_call）—— 从 ToolCallEvent 转化
 *  全部按时间戳排序，输出全局时间线。
 */

import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../types/index.js"
import type { ToolCallEvent } from "../trace/collector.js"
import type { SessionManifestEntry } from "../trace/types.js"
import type { HistoryEvent, HistoryBuildResult } from "./schema.js"

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

/**
 * 构建 History（纯函数）
 *
 * 步骤：
 *  1. 生成 Workflow 执行树事件
 *  2. 生成 Agent 事件 + 工具调用事件
 *  3. 按时间戳排序
 *  4. 生成 JSONL 和 Markdown
 */
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
  // 建立 agentId -> events 的索引
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
    // 该 agent 的工具调用事件（仅非回放 agent 有工具事件）
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

  // 3. 按时间戳排序
  events.sort((a, b) => a.ts - b.ts)

  // 4. 生成 JSONL 和 Markdown
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n")
  const md = buildMarkdown(input, events)

  return { jsonl, md: jsonl ? md : "" }
}

/** 生成人可读 Markdown */
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
    const statusTag = wf.status === "ok" ? "ok" : wf.status
    lines.push(`${indent}- [${statusTag}] ${wf.label}${duration}`)
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
