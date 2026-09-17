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

// ---------- ExecutionLock（Phase 3：防执行重叠，overlapPolicy=skip） ----------

export function executionLocksDir(directory: string): string {
  return path.join(directory, ".opencode-workflows", "execution-locks")
}

interface LockContent {
  scheduleId: string
  pid: number
  startedAt: string
}

/** 持锁进程是否已死（同机 project-scoped 下 pid 检测有效；EPERM 视为存活） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * 获取执行锁：wx 原子创建；被占时检测持有进程——已死视为僵尸锁，删锁重抢一次。
 * 返回 true = 持锁（调用方负责 run 结束 releaseExecutionLock）
 */
export function acquireExecutionLock(directory: string, scheduleId: string): boolean {
  fs.mkdirSync(executionLocksDir(directory), { recursive: true })
  const lockPath = path.join(executionLocksDir(directory), `${scheduleId}.lock`)
  const content: LockContent = { scheduleId, pid: process.pid, startedAt: new Date().toISOString() }
  const create = () => {
    try {
      const fd = fs.openSync(lockPath, "wx")
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
  if (create()) return true
  // 被占：僵尸检测（持有进程已死则删锁重抢）
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const held = JSON.parse(raw) as LockContent
    if (held.pid && !isPidAlive(held.pid)) {
      fs.rmSync(lockPath, { force: true })
      return create()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 锁文件间隙消失（持有方已释放）：直接重抢
      return create()
    }
    // 锁文件损坏（半写窗口等）视为僵尸，删锁重抢；删失败则 create 会 EEXIST 返回 false（安全）
    fs.rmSync(lockPath, { force: true })
    return create()
  }
  return false
}

/** 释放执行锁（run 终态后调用；不存在静默） */
export function releaseExecutionLock(directory: string, scheduleId: string): void {
  fs.rmSync(path.join(executionLocksDir(directory), `${scheduleId}.lock`), { force: true })
}
