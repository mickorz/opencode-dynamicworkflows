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

function isNodeStatus(value: unknown): value is WorkflowNode["status"] {
  return value === "running" || value === "ok" || value === "failed" || value === "aborted"
}

function isProgressStatus(value: unknown): value is WorkflowProgressStatus {
  return value === "running" || value === "completed" || value === "aborted" || value === "failed"
}
