/**
 * workflow 运行快照（F-20 实时通道 / Docs/TUI实时通道优化方案.md 第 3 节）
 *
 * 通道职责：server 在 workflow 执行期（前台与后台）把 records 快照原子写入
 * <项目目录>/.opencode-workflows/runs/<runId>.json，TUI 每秒轮询读取渲染实时树。
 * 这是执行期的唯一实时通道（context.metadata 执行期推送经实证不产生事件，见需求文档 9.6/9.8）。
 *
 * 三道防线（照抄 oh-my-openagent mirror 纪律，参考实现 05 文档）：
 *  1. 原子写：tmp + rename（Windows 覆盖失败时 unlink 后重 rename）
 *  2. 版本号：形状变化必须 bump RUN_SNAPSHOT_VERSION，旧读者静默丢弃
 *  3. 新鲜度：running 态超过 RUN_SNAPSHOT_STALE_MS 未更新，TUI 视为失联降级
 *
 * 快照是尽力而为的观测通道：读写失败一律降级（走 TUI 的完成态兜底或不渲染），
 * 与 journal 落盘同策略，绝不阻断工作流执行。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentRecord } from "../types/index.js"
import { buildProgressMetadata, type WorkflowProgressStatus } from "./workflow-progress.js"

export const RUN_SNAPSHOT_VERSION = 1
/** TUI 侧失联阈值（毫秒）。TUI 侧 reader 持有同值常量（跨进程契约，两处同步） */
export const RUN_SNAPSHOT_STALE_MS = 8000
/** 心跳间隔（毫秒）：快照只在 agent 状态迁移时写，并行 agent 长时间无迁移会被误判失联，
 * 心跳补时间戳（omo 同款设计，见参考实现 05 文档）。需远小于失联阈值 */
export const RUN_SNAPSHOT_HEARTBEAT_MS = 3000

/** 镜像快照形状（3.1 节契约；agents 即 AgentRecord 数组，已含 sessionId） */
export interface RunSnapshot {
  version: number
  runId: string
  parentSessionId: string
  name?: string
  status: WorkflowProgressStatus
  /** 写入时刻（毫秒），TUI 失联判定与排序依据 */
  time: number
  phases: string[]
  agents: ReadonlyArray<AgentRecord>
  running: number
  completed: number
  failed: number
  total: number
}

/** 组快照对象（纯函数；序列化逻辑复用 buildProgressMetadata，保证与完成态 metadata 字段一致） */
export function buildRunSnapshot(input: {
  runId: string
  parentSessionId: string
  name?: string
  status: WorkflowProgressStatus
  records: ReadonlyArray<AgentRecord>
  time: number
}): RunSnapshot {
  const progress = buildProgressMetadata({
    runId: input.runId,
    name: input.name,
    status: input.status,
    records: input.records,
  })
  return {
    version: RUN_SNAPSHOT_VERSION,
    parentSessionId: input.parentSessionId,
    time: input.time,
    ...progress,
  }
}

export function runSnapshotsDir(directory: string): string {
  return join(directory, ".opencode-workflows", "runs")
}

export function runSnapshotPath(directory: string, runId: string): string {
  return join(runSnapshotsDir(directory), `${runId}.json`)
}

/** 尽力而为写入：失败静默降级（观测通道不阻断工作流，与 journal 落盘同策略） */
export function tryWriteRunSnapshot(directory: string, snapshot: RunSnapshot): void {
  try {
    const file = runSnapshotPath(directory, snapshot.runId)
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, "utf8")
    try {
      renameSync(tmp, file)
    } catch {
      // Windows 对已存在目标的 rename 可能失败：删除后重试
      rmSync(file, { force: true })
      renameSync(tmp, file)
    }
  } catch {
    // 写失败（目录只读/磁盘满等）：TUI 走完成态兜底或不渲染
  }
}

function isTerminalStatus(status: unknown): boolean {
  return status === "completed" || status === "aborted" || status === "failed"
}

/** 新 run 启动前清理：删除同 parentSessionId 的终态快照（活快照不动，支持并发后台 run） */
export function cleanupRunSnapshots(directory: string, parentSessionId: string): void {
  try {
    const dir = runSnapshotsDir(directory)
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue
      const file = join(dir, entry)
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { parentSessionId?: string; status?: string }
        if (parsed.parentSessionId === parentSessionId && isTerminalStatus(parsed.status)) {
          rmSync(file, { force: true })
        }
      } catch {
        // 单个坏文件跳过，不影响其余清理
      }
    }
  } catch {
    // 清理失败不阻断运行
  }
}

/** 读取某会话的全部快照（解析失败的文件跳过），按 time 降序 */
export function readRunSnapshots(directory: string, parentSessionId: string): RunSnapshot[] {
  const dir = runSnapshotsDir(directory)
  if (!existsSync(dir)) return []
  const snapshots: RunSnapshot[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Record<string, unknown>
      if (parsed.version !== RUN_SNAPSHOT_VERSION) continue
      if (parsed.parentSessionId !== parentSessionId) continue
      if (typeof parsed.runId !== "string" || typeof parsed.time !== "number") continue
      snapshots.push(parsed as unknown as RunSnapshot)
    } catch {
      // 坏文件跳过
    }
  }
  snapshots.sort((a, b) => b.time - a.time)
  return snapshots
}
