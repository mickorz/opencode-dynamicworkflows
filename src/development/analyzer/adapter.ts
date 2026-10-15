/**
 * P3 Analyzer 适配层
 *
 * 把 TraceStore 的原始数据合并为 AnalysisToolEvent[]
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
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import type { ToolCallEvent } from "../../trace/collector.js"
import { dedupeByCallID as dedupe } from "../../trace/collector.js"
import type { TraceManifest, SessionManifestEntry } from "../../trace/types.js"
import type { TraceStore } from "../../trace/store.js"
import type { AgentRecord } from "../../types/index.js"
import type { AnalysisToolEvent } from "./types.js"

/**
 * 构建分析事件列表
 *
 * @param store TraceStore 实例
 * @param runId Run ID
 * @param manifest Trace Manifest
 * @param agents 真实 AgentRecord 数组
 * @param runAttemptId P3.2: Run 执行轮次 ID（定位 attempt 目录）
 * @returns 合并后的 AnalysisToolEvent[]（按 startedAt 排序）
 */
export function buildAnalysisEvents(
  store: TraceStore,
  runId: string,
  manifest: TraceManifest,
  agents: AgentRecord[],
  runAttemptId?: string,
): AnalysisToolEvent[] {
  // 按 sessionId 建立索引
  const agentBySession = new Map<string, AgentRecord>()
  for (const agent of agents) {
    if (agent.sessionId) {
      agentBySession.set(agent.sessionId, agent)
    }
  }

  const result: AnalysisToolEvent[] = []

  for (const session of manifest.sessions) {
    // 读取该 session 的全部 ToolCallEvent（P3.2: 传入 runAttemptId 定位 attempt 目录）
    const rawEvents = store.readSessionTrace(runId, session.sessionId, runAttemptId)
    if (rawEvents.length === 0) continue

    // callID 去重：同一 callID 只保留最终态
    const deduped = dedupe(rawEvents)

    // 关联 AgentRecord
    const agent = agentBySession.get(session.sessionId)

    for (const event of deduped) {
      result.push(toAnalysisEvent(event, session, agent))
    }
  }

  // 按 startedAt 排序（无 startedAt 的排到最后）
  result.sort((a, b) => {
    const ta = a.startedAt ?? Number.MAX_SAFE_INTEGER
    const tb = b.startedAt ?? Number.MAX_SAFE_INTEGER
    return ta - tb
  })

  return result
}

/**
 * 将 ToolCallEvent + SessionManifestEntry + AgentRecord 合并为 AnalysisToolEvent
 */
function toAnalysisEvent(
  event: ToolCallEvent,
  session: SessionManifestEntry,
  agent: AgentRecord | undefined,
): AnalysisToolEvent {
  return {
    ...event,
    // 优先用 AgentRecord 的 id（真实执行身份），回退到 manifest 的 agentId
    agentId: agent?.id ?? session.agentId,
    // 优先用 AgentRecord 的 label，回退到 manifest 的 agentLabel
    agentLabel: agent?.label ?? session.agentLabel,
    sessionId: session.sessionId,
    // 优先用 AgentRecord 的 workflowScopePath，回退到 manifest 的
    workflowScopePath: agent?.workflowScopePath ?? session.workflowScopePath ?? [],
    // 优先用 AgentRecord 的 replayed，回退到 manifest 的
    replayed: agent?.replayed ?? session.replayed,
  }
}
