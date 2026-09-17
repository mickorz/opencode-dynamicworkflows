/**
 * 多实例协调层（P1）
 *
 * TriggerClaim（Phase 1）：
 *  schedule-claims/<scheduleId>/<epoch>.claim
 *  - 文件名 = slot.getTime()（epoch 毫秒）：唯一/稳定/可排序/跨平台（Windows 禁 ":"）
 *  - fs.open(path, "wx") 原子创建：多 TUI 同时抢同一 slot 时恰一个成功（EEXIST 即失败）
 *  - claim 长期保留 = 持久化游标（同 TUI 多 tick / 多 TUI / 重启后都不会对旧 slot 重复触发）
 *  - 禁止 exists -> write 两步式（TOCTOU race）
 *
 * ExecutionLock（Phase 3 落地，接口先行占位）：
 *  execution-locks/<scheduleId>.lock，防同 schedule 执行重叠（overlapPolicy=skip）
 */

import fs from "node:fs"
import path from "node:path"

/** claim 保留时长：7 天（保留期内重开 TUI 不对历史 slot 补触发） */
export const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function claimsRoot(directory: string): string {
  return path.join(directory, ".opencode-workflows", "schedule-claims")
}

/** claim 文件内容（人读调试信息；判定逻辑只依赖文件存在性） */
interface ClaimContent {
  scheduleId: string
  scheduledAt: string
  claimedAt: string
  pid: number
}

/**
 * 原子认领一个 slot：成功返回 true；已被任何实例认领（含历史残留）返回 false。
 * slot 为该次计划运行的时间点（latestSlot 的结果）。
 */
export function tryClaim(directory: string, scheduleId: string, slot: Date): boolean {
  const dir = path.join(claimsRoot(directory), scheduleId)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${slot.getTime()}.claim`)
  const content: ClaimContent = {
    scheduleId,
    scheduledAt: slot.toISOString(),
    claimedAt: new Date().toISOString(),
    pid: process.pid,
  }
  try {
    const fd = fs.openSync(filePath, "wx")
    try {
      fs.writeSync(fd, JSON.stringify(content, null, 2))
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

/** 删除过期 claim（epoch 文件名天然可按数值排序）；返回删除数 */
export function pruneClaims(directory: string, now = Date.now(), retentionMs = CLAIM_RETENTION_MS): number {
  const root = claimsRoot(directory)
  if (!fs.existsSync(root)) return 0
  let removed = 0
  for (const scheduleDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!scheduleDir.isDirectory()) continue
    const dir = path.join(root, scheduleDir.name)
    for (const file of fs.readdirSync(dir)) {
      const epoch = Number(file.replace(/\.claim$/, ""))
      if (Number.isFinite(epoch) && now - epoch > retentionMs) {
        fs.rmSync(path.join(dir, file))
        removed++
      }
    }
  }
  return removed
}

// ---------- ExecutionLock（Phase 3 落地） ----------
// 设计定案（见 Docs/01_需求与规划/Schedule功能P1执行计划.md D13/D14）：
//  - acquireExecutionLock(directory, scheduleId, runId)：wx 创建 execution-locks/<scheduleId>.lock
//    内容 { pid, runId, startedAt }；被占且持有 pid 存活 -> false（skip）；pid 已死 -> 删锁重抢
//  - releaseExecutionLock(directory, scheduleId)：run 结束删除
//  - 锁 key 用 scheduleId 而非 workflowId（两个 schedule 引用同一 workflow 合法）
