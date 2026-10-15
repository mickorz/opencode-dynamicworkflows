/**
 * P3-B 四类规则修正版
 *
 * Rule 1 Repeat：递归 stableStringify + 仅 Observation 不生成 Proposal
 * Rule 2 Retry：时间窗口 30s + 参数关联 + confirmed/possible 分级
 * Rule 3 Dependency：write/read 同文件关联，Observation
 * Rule 4 Latency：per-Agent 内 Next.startedAt - Prev.endedAt，仅 Observation
 *
 * v3 关键修正：
 *  - stableStringify 递归排序嵌套对象键（v2 的 JSON.stringify replacer 会过滤嵌套属性）
 *  - Repeat/Latency 不直接生成 Proposal（留给 LLM 审阅判断）
 *  - Latency 的 durationMs/firstToolDelayMs 缺失时标 "unknown"
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { createHash } from "node:crypto"
import type { AgentRecord } from "../../types/index.js"
import type {
  AnalysisToolEvent,
  RepeatObservation,
  RetryObservation,
  DependencyObservation,
  LatencyAnalysis,
} from "./types.js"

// ============================================================
// 共用工具函数
// ============================================================

/**
 * 递归稳定序列化：对对象键按字母序排序（包括嵌套对象），然后返回完整序列化字符串。
 *
 * v3 bug 修正：v2 用 JSON.stringify(obj, Object.keys().sort()) 的数组式 replacer，
 * 该 replacer 会过滤嵌套对象的属性（只保留 replacer 数组中列出的键），
 * 导致不同对象的嵌套属性被丢弃，序列化结果错误相同。
 *
 * P3.1 加固：
 *  - 对象键使用 JSON.stringify(k) 转义（正确处理特殊字符如引号、反斜杠）
 *  - undefined 值跳过（与 JSON.stringify 行为一致，不产生无效序列化）
 *  - 函数和 Symbol 值跳过（JSON 不支持）
 *  - 数组保持顺序（不排序数组元素）
 */
export function stableStringify(obj: unknown): string {
  if (obj === null) return "null"
  if (typeof obj !== "object") {
    if (typeof obj === "undefined") return "null"
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort()
  const pairs: string[] = []
  for (const k of keys) {
    const val = (obj as Record<string, unknown>)[k]
    // 跳过 undefined 和函数（与 JSON.stringify 行为一致）
    if (val === undefined || typeof val === "function" || typeof val === "symbol") continue
    pairs.push(`${JSON.stringify(k)}:${stableStringify(val)}`)
  }
  return `{${pairs.join(",")}}`
}

/** 移除纯展示字段（如 metadata），保留 filePath/content/command 等业务字段 */
export function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const { metadata, ...rest } = input
  return rest
}

/** 计算工具调用签名 = sha256(tool + ":" + stableStringify(normalizeInput(input))) 前 16 字符 */
export function signature(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}:${stableStringify(normalizeInput(input))}`)
    .digest("hex")
    .slice(0, 16)
}

// ============================================================
// Rule 1: 重复操作检测
// ============================================================

/**
 * 规则 1：重复操作检测
 *
 * 签名 = sha256(tool + ":" + stableStringify(normalizeInput(input)))
 *
 * 输出 Observation（观察事实），不直接生成 Proposal。
 * 重复读取同一文件不一定多余（中间文件可能已变化）。
 * 只有 LLM 审阅或人工确认后才能提升为优化机会。
 */
export function detectRepeats(events: AnalysisToolEvent[]): RepeatObservation[] {
  // 按签名分组
  const groups = new Map<string, AnalysisToolEvent[]>()

  for (const event of events) {
    // 只分析 completed 的事件
    if (event.status !== "completed") continue
    const sig = signature(event.tool, event.input)
    const group = groups.get(sig)
    if (group) {
      group.push(event)
    } else {
      groups.set(sig, [event])
    }
  }

  const observations: RepeatObservation[] = []

  for (const [sig, group] of groups) {
    if (group.length < 2) continue

    observations.push({
      tool: group[0].tool,
      inputSignature: sig,
      count: group.length,
      occurrences: group.map((e) => ({
        ts: e.startedAt ?? 0,
        agentLabel: e.agentLabel,
        callID: e.callID,
        sessionId: e.sessionId,
      })),
    })
  }

  return observations
}

// ============================================================
// Rule 2: 失败重试链
// ============================================================

/** retry 时间窗口：30 秒内才算重试链 */
const RETRY_WINDOW_MS = 30_000

/**
 * 规则 2：失败重试链
 *
 * 匹配条件：
 *  1. 找到 status=error 的事件
 *  2. 在同一 Agent 内，RETRY_WINDOW_MS 内找到同 tool 的后续事件
 *  3. 如果 input 签名相同 → confirmed
 *     如果 input 签名不同 → possible
 *
 * 输出 RetryObservation，confirmed/possible 分级。
 */
export function detectRetries(events: AnalysisToolEvent[]): RetryObservation[] {
  const observations: RetryObservation[] = []

  // 按 agentId 分组
  const byAgent = new Map<string, AnalysisToolEvent[]>()
  for (const event of events) {
    const group = byAgent.get(event.agentId)
    if (group) {
      group.push(event)
    } else {
      byAgent.set(event.agentId, [event])
    }
  }

  for (const [, agentEvents] of byAgent) {
    // 在 Agent 内查找 error → 后续同 tool 的链
    for (let i = 0; i < agentEvents.length; i++) {
      const failed = agentEvents[i]
      if (failed.status !== "error") continue

      // 在时间窗口内找同 tool 的后续事件
      for (let j = i + 1; j < agentEvents.length; j++) {
        const next = agentEvents[j]
        if (next.tool !== failed.tool) continue

        const failedTs = failed.startedAt ?? 0
        const nextTs = next.startedAt ?? 0
        if (nextTs < failedTs) continue // 时间倒序保护
        if (nextTs - failedTs > RETRY_WINDOW_MS) break // 超出时间窗口

        // 判断参数是否相同
        const failedSig = signature(failed.tool, failed.input)
        const nextSig = signature(next.tool, next.input)
        const confidence = failedSig === nextSig ? "confirmed" : "possible"

        observations.push({
          tool: failed.tool,
          confidence,
          failedAt: failedTs,
          failedCallID: failed.callID,
          retryAt: nextTs,
          retryCallID: next.callID,
          error: failed.error,
          agentLabel: failed.agentLabel,
          agentId: failed.agentId,
        })

        break // 一个 error 只匹配第一个后续同 tool
      }
    }
  }

  return observations
}

// ============================================================
// Rule 3: 顺序依赖链
// ============================================================

/**
 * 规则 3：顺序依赖链
 *
 * 从 write/edit 工具的 input.filePath 提取产出路径，
 * 匹配后续 read/bash 工具的 input.filePath/input.command 中的同一路径。
 *
 * 输出 DependencyObservation。
 */
export function detectDependencies(events: AnalysisToolEvent[]): DependencyObservation[] {
  const observations: DependencyObservation[] = []

  // 收集所有 write/edit 产生的文件路径
  const writes: Array<{ event: AnalysisToolEvent; filePath: string }> = []
  for (const event of events) {
    if (event.status !== "completed") continue
    if (event.tool !== "write" && event.tool !== "edit") continue
    const filePath = event.input.filePath as string | undefined
    if (!filePath) continue
    writes.push({ event, filePath })
  }

  // 对每个 write，找后续 read/bash 中引用同路径的事件
  for (const { event: writeEvent, filePath } of writes) {
    const chain: DependencyObservation["chain"] = [
      {
        ts: writeEvent.startedAt ?? 0,
        tool: writeEvent.tool,
        agentLabel: writeEvent.agentLabel,
        callID: writeEvent.callID,
        filePath,
      },
    ]

    const writeTs = writeEvent.startedAt ?? 0

    for (const event of events) {
      if (event.status !== "completed") continue
      if (event.startedAt === undefined || event.startedAt < writeTs) continue
      if (event.callID === writeEvent.callID) continue

      // 检查 read 的 filePath
      if (event.tool === "read") {
        const readPath = event.input.filePath as string | undefined
        if (readPath && pathsMatch(readPath, filePath)) {
          chain.push({
            ts: event.startedAt ?? 0,
            tool: event.tool,
            agentLabel: event.agentLabel,
            callID: event.callID,
            filePath: readPath,
          })
        }
      }

      // 检查 bash 的 command 中是否包含该路径
      if (event.tool === "bash") {
        const command = event.input.command as string | undefined
        if (command && command.includes(filePath)) {
          chain.push({
            ts: event.startedAt ?? 0,
            tool: event.tool,
            agentLabel: event.agentLabel,
            callID: event.callID,
            filePath,
          })
        }
      }
    }

    if (chain.length >= 2) {
      observations.push({
        chain,
        chainType: `${writeEvent.tool}->${chain.slice(1).map((c) => c.tool).join("->")}`,
      })
    }
  }

  return observations
}

/** 简单路径匹配（忽略首尾斜杠差异） */
function pathsMatch(a: string, b: string): boolean {
  return a.replace(/^[./]+/, "").replace(/\/+$/, "") === b.replace(/^[./]+/, "").replace(/\/+$/, "")
}

// ============================================================
// Rule 4: 耗时分布
// ============================================================

/**
 * 规则 4：耗时分布
 *
 * per-Agent 分析：
 *  1. 各 agent 的 durationMs（from 真实 AgentRecord，缺失标 unknown）
 *  2. agent_start 到首个 tool_call 的延迟
 *  3. Agent 内相邻工具调用的空闲间隔 = Next.startedAt - Prev.endedAt
 *
 * 不跨 Agent 相减（并行 Agent 的工具调用时间线交叠，相减无意义）。
 * gap 只标为"空闲间隔"，不臆测原因。
 * v3：Latency 是诊断观察，不直接生成 Proposal。
 */
export function analyzeLatency(events: AnalysisToolEvent[], agents: AgentRecord[]): LatencyAnalysis {
  // 按 agentId 建立索引
  const agentMap = new Map<string, AgentRecord>()
  for (const agent of agents) {
    agentMap.set(agent.id, agent)
  }

  // 按 agentId 分组事件
  const byAgent = new Map<string, AnalysisToolEvent[]>()
  for (const event of events) {
    const group = byAgent.get(event.agentId)
    if (group) {
      group.push(event)
    } else {
      byAgent.set(event.agentId, [event])
    }
  }

  // 按 startedAt 排序各组内事件
  for (const [, group] of byAgent) {
    group.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  const agentAnalyses: LatencyAnalysis["agents"] = []
  let totalMs = 0

  for (const [agentId, agentEvents] of byAgent) {
    const agent = agentMap.get(agentId)

    // durationMs 来自真实 AgentRecord，缺失标 unknown
    const durationMs = agent?.durationMs ?? "unknown"

    // startedAt 来自真实 AgentRecord，缺失用首个事件时间（仅用于排序）
    const agentStart = agent?.startedAt ?? agentEvents[0]?.startedAt ?? 0

    // firstToolDelayMs = 首个 tool_call.startedAt - agent.startedAt
    // AgentRecord 缺失时标 unknown（不填造数据）
    const firstEvent = agentEvents[0]
    const firstToolDelayMs = agent?.startedAt !== undefined && firstEvent?.startedAt !== undefined
      ? firstEvent.startedAt - agent.startedAt
      : "unknown"

    // idleGaps: Agent 内相邻工具调用的空闲间隔
    const idleGaps: Array<{ fromCallID: string; toCallID: string; gapMs: number }> = []
    for (let i = 0; i < agentEvents.length - 1; i++) {
      const prev = agentEvents[i]
      const next = agentEvents[i + 1]
      if (prev.endedAt !== undefined && next.startedAt !== undefined) {
        const gap = next.startedAt - prev.endedAt
        if (gap > 0) {
          idleGaps.push({
            fromCallID: prev.callID,
            toCallID: next.callID,
            gapMs: gap,
          })
        }
      }
    }

    // 计算该 agent 的 wall-clock 时间
    const lastEvent = agentEvents[agentEvents.length - 1]
    if (agent?.startedAt && lastEvent?.endedAt) {
      totalMs += lastEvent.endedAt - agent.startedAt
    }

    agentAnalyses.push({
      agentId,
      agentLabel: agent?.label ?? agentEvents[0]?.agentLabel ?? "unknown",
      startedAt: agentStart,
      durationMs,
      firstToolDelayMs,
      idleGaps,
    })
  }

  return {
    agents: agentAnalyses,
    totalMs,
  }
}
