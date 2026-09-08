/**
 * TUI 侧 workflow 状态提取（F-20 / TUI 增强 MVP-1 前台通道的读取端）
 *
 * 数据来源：workflow tool 经 ToolContext.metadata 写进 ToolPart.state.metadata 的
 * 进度快照（形状见 src/tools/workflow-progress.ts，两侧共用同一契约）。
 *
 * 本文件是纯 TypeScript（无 solid-js 依赖），可被 node:test 直接测试；
 * solid 渲染集中在 plugin.tsx 单文件（需求文档 9.3 单实例约束）。
 */

import { type RunSnapshotView, RUN_SNAPSHOT_STALE_MS } from "./run-snapshot-reader.js"

export type WorkflowProgressStatus = "running" | "completed" | "aborted" | "failed"
export type WorkflowNodeStatus = "running" | "ok" | "failed" | "aborted"

/** 与 server 侧 AgentRecord 对应的节点（结构性宽松校验后的安全形状） */
export interface WorkflowNode {
  id: string
  label: string
  phase?: string
  status: WorkflowNodeStatus
  durationMs?: number
  sessionId?: string
  tokens?: number
  cost?: number
  error?: string
  replayed?: boolean
  model?: string
}

export interface WorkflowProgress {
  runId: string
  name: string
  status: WorkflowProgressStatus
  phases: string[]
  nodes: WorkflowNode[]
  running: number
  completed: number
  failed: number
  total: number
}

/** sidebar 展示行：phase 标题行或 agent 节点行 */
export type SidebarRow = { kind: "phase"; title: string } | { kind: "node"; node: WorkflowNode }

/** ToolPart.metadata 是 any（无类型约束），形状校验失败一律返回 null 防崩（旧结构/异构数据） */
export function parseWorkflowMetadata(raw: unknown): WorkflowProgress | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.runId !== "string" || !rec.runId) return null
  if (!Array.isArray(rec.agents)) return null

  const nodes: WorkflowNode[] = []
  for (const item of rec.agents) {
    if (!item || typeof item !== "object") continue
    const n = item as Record<string, unknown>
    if (typeof n.id !== "string" || typeof n.label !== "string" || typeof n.status !== "string") continue
    if (!isNodeStatus(n.status)) continue
    nodes.push({
      id: n.id,
      label: n.label,
      phase: typeof n.phase === "string" ? n.phase : undefined,
      status: n.status,
      durationMs: typeof n.durationMs === "number" ? n.durationMs : undefined,
      sessionId: typeof n.sessionId === "string" ? n.sessionId : undefined,
      tokens: typeof n.tokens === "number" ? n.tokens : undefined,
      cost: typeof n.cost === "number" ? n.cost : undefined,
      error: typeof n.error === "string" ? n.error : undefined,
      replayed: n.replayed === true,
      model: typeof n.model === "string" ? n.model : undefined,
    })
  }
  if (nodes.length === 0) return null

  const phases: string[] = []
  for (const node of nodes) {
    if (node.phase && !phases.includes(node.phase)) phases.push(node.phase)
  }

  const status: WorkflowProgressStatus = isProgressStatus(rec.status) ? rec.status : "running"
  return {
    runId: rec.runId,
    name: typeof rec.name === "string" && rec.name ? rec.name : "workflow",
    status,
    phases,
    nodes,
    running: nodes.filter((n) => n.status === "running").length,
    completed: nodes.filter((n) => n.status === "ok").length,
    failed: nodes.filter((n) => n.status === "failed").length,
    total: nodes.length,
  }
}

/** 消息的最小结构形状（避免 TUI 侧直接依赖 SDK 类型定义；state 用 unknown 兼容各状态变体） */
export interface ToolPartLike {
  type: string
  tool?: string
  state?: unknown
}

/**
 * 从会话消息里找最近一次 workflow tool 调用的 metadata（从后往前扫描）。
 * 注意：TUI sync store 里 message 与 part 分开存（store.message 按 sessionID、
 * store.part 按 messageID），message 对象不带内联 parts——必须经 getParts(messageID)
 * 取每个消息的 part 列表（TuiState.part 就是这个 API）。
 */
export function findWorkflowMetadata(
  messages: ReadonlyArray<{ id?: unknown }>,
  getParts: (messageID: string) => ReadonlyArray<ToolPartLike> | undefined,
): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageID = messages[i].id
    if (typeof messageID !== "string") continue
    const parts = getParts(messageID) ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      const state = part.state as { metadata?: unknown } | undefined
      if (part.type === "tool" && part.tool === "workflow") return state?.metadata
    }
  }
  return undefined
}

/**
 * 组装 sidebar 展示行：按执行顺序遍历节点，phase 变化时插入标题行
 * （连续同 phase 的节点自然成组；无 phase 的节点直接平铺，不产生标题行）
 */
export function buildSidebarRows(progress: WorkflowProgress): SidebarRow[] {
  const rows: SidebarRow[] = []
  let currentPhase: string | undefined
  for (const node of progress.nodes) {
    if (node.phase && node.phase !== currentPhase) {
      rows.push({ kind: "phase", title: node.phase })
      currentPhase = node.phase
    }
    rows.push({ kind: "node", node })
  }
  return rows
}

/**
 * 通道合并规则（TUI实时通道优化方案 6 节）：
 * 1. 最新快照非失联 -> 镜像优先（执行期与后台的实时主通道）
 * 2. 否则 -> C 通道（tool 返回值 metadata）兑底；旧会话重开 与 镜像写失败时生效
 */
export function pickBestProgress(
  snapshots: ReadonlyArray<RunSnapshotView>,
  metadataProgress: WorkflowProgress | null,
  now: number,
): WorkflowProgress | null {
  const latest = snapshots[0]
  if (latest) {
    const stale = latest.status === "running" && now - latest.time > RUN_SNAPSHOT_STALE_MS
    if (!stale) {
      return {
        runId: latest.runId,
        name: latest.name,
        status: latest.status,
        phases: latest.phases,
        nodes: latest.nodes,
        running: latest.running,
        completed: latest.completed,
        failed: latest.failed,
        total: latest.total,
      }
    }
  }
  return metadataProgress
}

/** viewKey：稳定字符串摘要，不变则不写 signal 避免无谓重渲（omo viewKey 差分） */
export function progressViewKey(progress: WorkflowProgress | null): string {
  if (!progress) return "none"
  return `${progress.runId}|${progress.status}|${progress.total}|${progress.completed}|${progress.running}|${progress.failed}`
}

/** 耗时展示：843ms -> 0.8s / 12300ms -> 12.3s / 75000ms -> 1m15s */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ""
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`
}

function isNodeStatus(value: unknown): value is WorkflowNodeStatus {
  return value === "running" || value === "ok" || value === "failed" || value === "aborted"
}

function isProgressStatus(value: unknown): value is WorkflowProgressStatus {
  return value === "running" || value === "completed" || value === "aborted" || value === "failed"
}
