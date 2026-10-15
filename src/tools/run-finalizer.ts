/**
 * RunFinalizer —— Run 终态后统一采集 Trace 与构建 History（P1）
 *
 * 类头流程图：
 *
 *  Run 终态 completed failed aborted
 *        |
 *        v
 *  遍历全部 Agent Record
 *    筛选非回放 agent 取 sessionId
 *    回放 agent 标记 provenance
 *        |
 *        v
 *  Adapter collectSessionTrace
 *    调 session.messages 拉取全部消息
 *    喂 parseSessionMessages 解析
 *    返回 ToolCallEvent 数组
 *        |
 *        v
 *  TraceStore 落盘
 *    traces/sessionId.jsonl 每会话一条
 *    manifest.json 采集完整性
 *        |
 *        v
 *  HistoryBuilder 合并
 *    执行树 父子 Workflow 层级
 *    全局时间线 按时间排序
 *    回放 agent 来源关联
 *        |
 *        v
 *  写出 history.jsonl + history.md
 *
 * 接入点：
 *  - 前台 workflow.ts 的 finally 块
 *  - 后台 background-runs.ts 的 finally 块（定时经此间接覆盖）
 *
 * 约束：
 *  - 采集失败不阻断 run 终态（Trace 是尽力而为）
 *  - 回放 agent 无新 session，不调 session.messages()
 */

import { TraceStore } from "../trace/store.js"
import type { TraceManifest, SessionManifestEntry } from "../trace/types.js"
import type { ToolCallEvent } from "../trace/collector.js"
import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../types/index.js"
import { buildHistory } from "../history/builder.js"

/** Adapter 的 Trace 采集端口（仅取 collectSessionTrace，解耦具体 Adapter 类） */
export interface TraceCollectorPort {
  collectSessionTrace(sessionId: string, directory?: string): Promise<ToolCallEvent[]>
}

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
  adapter: TraceCollectorPort
  trigger?: { type: string; scheduleId?: string; scheduledAt?: string }
  /** 原 runId（Resume 场景，用于回放 agent 的 Trace 回溯） */
  resumeFromRunId?: string
  /** P2: 是否开启 Development 模式（记录到 manifest） */
  development?: boolean
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
      const originalSessionId = agent.sessionId
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
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    startedAt: input.startedAt,
    endedAt: Date.now(),
    status: input.status,
    completeness,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.development !== undefined ? { development: input.development } : {}),
    sessions: sessionEntries,
  }
  store.writeManifest(input.runId, manifest)

  return {
    historyPath: store.runDir(input.runId),
    manifest,
    completeness,
  }
}
