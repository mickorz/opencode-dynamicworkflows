/**
 * TUI 侧运行快照读取（F-20 实时通道 / TUI实时通道优化方案 5.1 节）
 *
 * 读取 server 写入的 .opencode-workflows/runs/<runId>.json（契约见
 * src/tools/run-snapshot.ts，两处常量与形状跨进程同步，TUI 侧禁止
 * import server 模块，按结构自行宽松校验防崩——与 workflow-store 同原则）。
 *
 * 纯 TypeScript 无 solid 依赖，node:test 直接可测。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowNode, WorkflowProgress, WorkflowProgressStatus } from "./workflow-store.js"

/** 与 server 侧 RUN_SNAPSHOT_VERSION 同步（跨进程契约） */
const RUN_SNAPSHOT_VERSION = 1
/** 与 server 侧 RUN_SNAPSHOT_STALE_MS 同步（跨进程契约） */
export const RUN_SNAPSHOT_STALE_MS = 8000

export interface RunSnapshotView {
  version: number
  runId: string
  parentSessionId: string
  name: string
  status: WorkflowProgressStatus
  time: number
  phases: string[]
  nodes: WorkflowNode[]
  running: number
  completed: number
  failed: number
  total: number
}

/** 宽松校验 + 字段清洗（坏形状一律 null 防崩） */
export function parseRunSnapshot(raw: unknown): RunSnapshotView | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (rec.version !== RUN_SNAPSHOT_VERSION) return null
  if (typeof rec.runId !== "string" || !rec.runId) return null
  if (typeof rec.parentSessionId !== "string" || !rec.parentSessionId) return null
  if (typeof rec.time !== "number") return null
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
      executionId: typeof n.executionId === "string" ? n.executionId : undefined,
      attempt: typeof n.attempt === "number" ? n.attempt : undefined,
      outputType: n.outputType === "text" || n.outputType === "structured" ? n.outputType : undefined,
      outputPreview: typeof n.outputPreview === "string" ? n.outputPreview : undefined,
      inputTokens: typeof n.inputTokens === "number" ? n.inputTokens : undefined,
      outputTokens: typeof n.outputTokens === "number" ? n.outputTokens : undefined,
    })
  }
  if (nodes.length === 0) return null

  const status: WorkflowProgressStatus = isProgressStatus(rec.status) ? rec.status : "running"
  return {
    version: RUN_SNAPSHOT_VERSION,
    runId: rec.runId,
    parentSessionId: rec.parentSessionId,
    name: typeof rec.name === "string" && rec.name ? rec.name : "workflow",
    status,
    time: rec.time,
    phases: nodes
      .map((n) => n.phase)
      .filter((p): p is string => Boolean(p))
      .filter((p, i, arr) => arr.indexOf(p) === i),
    nodes,
    running: nodes.filter((n) => n.status === "running").length,
    completed: nodes.filter((n) => n.status === "ok").length,
    failed: nodes.filter((n) => n.status === "failed").length,
    total: nodes.length,
  }
}

/** 列某会话的全部快照（按 time 降序，最新在前）；目录不存在或读失败返回空 */
export function listSessionSnapshots(directory: string, sessionId: string): RunSnapshotView[] {
  const dir = join(directory, ".opencode-workflows", "runs")
  if (!existsSync(dir)) return []
  const snapshots: RunSnapshotView[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    try {
      const parsed = parseRunSnapshot(JSON.parse(readFileSync(join(dir, entry), "utf8")))
      if (parsed && parsed.parentSessionId === sessionId) snapshots.push(parsed)
    } catch {
      // 坏文件跳过
    }
  }
  snapshots.sort((a, b) => b.time - a.time)
  return snapshots
}

/** 失联判定：仅 running 态需要心跳，终态快照永不失联 */
export function isStale(snapshot: RunSnapshotView, now: number): boolean {
  return snapshot.status === "running" && now - snapshot.time > RUN_SNAPSHOT_STALE_MS
}

/** 快照映射为 sidebar 渲染用的 WorkflowProgress */
export function toProgress(snapshot: RunSnapshotView): WorkflowProgress {
  return {
    runId: snapshot.runId,
    name: snapshot.name,
    status: snapshot.status,
    phases: snapshot.phases,
    nodes: snapshot.nodes,
    running: snapshot.running,
    completed: snapshot.completed,
    failed: snapshot.failed,
    total: snapshot.total,
  }
}

/**
 * 从 runId 提取创建时间（runId 形如 run-<base36时间戳>[-序号]）。
 * 展示排序依据：心跳交错会反复改写快照 time，按 time 排序会导致两棵运行中的树不断互换位置；
 * 创建时间不变，顺序稳定（最新创建在上，旧的在下）。解析失败返回 0 排最后。
 */
export function runCreatedAt(runId: string): number {
  const parsed = Number.parseInt(runId.slice(4), 36)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * 通道合并规则（多树同显版）：不再裁决"只显示哪一个"，每个 run 一棵树同时渲染，
 * 天然消除双活快照 time 交错导致的横跳：
 * 1. 快照逐个映射为树；running 且超时未心跳的（失联）过滤不显示
 * 2. 快照列表为空时回退 C 通道（tool 返回值 metadata，旧会话重开/镜像写失败场景）
 * 3. 有快照时忽略 metadata（metadata 只是最新一次 tool 调用的终态，快照已覆盖）
 *
 * 展示顺序按 run 创建时间降序（最新创建的树在最上），与心跳写入时机无关，位置稳定不互换。
 */
export function pickAllProgresses(
  snapshots: ReadonlyArray<RunSnapshotView>,
  metadataProgress: WorkflowProgress | null,
  now: number,
): WorkflowProgress[] {
  const alive = snapshots.filter((s) => !isStale(s, now))
  if (alive.length === 0) return metadataProgress ? [metadataProgress] : []
  return alive.map(toProgress).sort((a, b) => runCreatedAt(b.runId) - runCreatedAt(a.runId))
}

function isNodeStatus(value: unknown): value is WorkflowNode["status"] {
  return value === "running" || value === "ok" || value === "failed" || value === "aborted"
}

function isProgressStatus(value: unknown): value is WorkflowProgressStatus {
  return value === "running" || value === "completed" || value === "aborted" || value === "failed"
}
