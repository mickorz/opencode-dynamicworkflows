/**
 * ScheduleRuntime（P1）—— In-Process 定时调度循环
 *
 * tick 链路（每 30 秒，无状态重读 schedules/*.json）：
 *  for each enabled schedule
 *   -> latestSlot(cron, now)            最近过去 slot（cron-parser prev()，无迭代成本）
 *   -> now - slot <= grace(90s) ?       超窗即错过（missed = skip，不补跑）
 *   -> tryClaim(scheduleId, slot)       原子抢锁（wx）；失败静默（另一实例/历史已认领）
 *   -> execute：fresh session + BackgroundRunManager 后台执行 + Record 落盘
 *
 * 设计边界（Docs/01_需求与规划/Schedule功能P1执行计划.md v4）：
 *  - at-most-once per slot：claim 成功后执行前崩溃 = 丢一轮（承诺内）
 *  - schedule JSON 运行时零写入（纯配置，无游标；claim 即游标）
 *  - 每 Run 独立 fresh session，不 prompt 回传（结果进 Record）
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundRunManager, type BackgroundRunInfo } from "../tools/background-runs.js"
import { latestSlot } from "./cron.js"
import { listSchedules } from "./store.js"
import { readWorkflowScript } from "../runtime/workflow-registry.js"
import { tryClaim, pruneClaims, acquireExecutionLock, releaseExecutionLock } from "./coordination.js"
import { writeRecord } from "./record.js"
import type { Schedule, ScheduleRun, ScheduleRunStatus } from "./types.js"

/** tick 间隔（30 秒） */
export const TICK_MS = 30_000
/** 触发宽容期：只容忍 tick 抖动，不承担 catch-up（错过 = skip） */
export const GRACE_MS = 90_000
/** claim 清理频率：每 20 tick（约 10 分钟）顺手 prune 一次 */
const PRUNE_EVERY_TICKS = 20

export interface ScheduleRuntimeDeps {
  client: PluginInput["client"]
  directory: string
  manager: BackgroundRunManager
  /** 时钟注入缝（测试用）；缺省 Date */
  now?: () => Date
  intervalMs?: number
  graceMs?: number
}

export class ScheduleRuntime {
  private readonly deps: ScheduleRuntimeDeps
  private readonly intervalMs: number
  private readonly graceMs: number
  private timer: NodeJS.Timeout | undefined
  private tickCount = 0

  constructor(deps: ScheduleRuntimeDeps) {
    this.deps = deps
    this.intervalMs = deps.intervalMs ?? TICK_MS
    this.graceMs = deps.graceMs ?? GRACE_MS
  }

  /** 启动调度循环（幂等） */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  /** 停止调度循环（不清在途 run；在途 run 由 BackgroundRunManager 管理） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  /** 单次 tick：判定全部到期 schedule 并触发（导出供测试直接调用） */
  async tick(): Promise<void> {
    this.tickCount++
    if (this.tickCount % PRUNE_EVERY_TICKS === 0) {
      try {
        pruneClaims(this.deps.directory)
      } catch {
        // 清理失败不影响本轮调度
      }
    }
    const now = this.now()
    const schedules = listSchedules(this.deps.directory)
    for (const schedule of schedules) {
      if (!schedule.enabled) continue
      const slot = latestSlot(schedule.cron, now)
      if (now.getTime() - slot.getTime() > this.graceMs) continue // 错过 = skip
      if (!tryClaim(this.deps.directory, schedule.id, slot)) continue // 已被认领，静默
      await this.execute(schedule, slot, "scheduled")
    }
  }

  /**
   * 执行一次：execution lock（overlap=skip）-> fresh session -> 后台 run（含 timeout / checkpoint 即败）-> Record
   * 返回 runId；被 overlap skip 或准备失败时 undefined。
   */
  private async execute(
    schedule: Schedule,
    slot: Date,
    trigger: "scheduled" | "manual",
  ): Promise<string | undefined> {
    const startedAt = new Date().toISOString()
    const base: ScheduleRun = {
      scheduleId: schedule.id,
      workflowId: schedule.workflowId,
      status: "running",
      trigger,
      scheduledAt: slot.toISOString(),
      slotEpoch: slot.getTime(),
      startedAt,
    }
    // overlapPolicy=skip（P1 唯一策略）：同 schedule 上一轮仍在跑 -> 写 skipped Record 不执行
    if (!acquireExecutionLock(this.deps.directory, schedule.id)) {
      writeRecord(this.deps.directory, {
        ...base,
        status: "skipped",
        finishedAt: new Date().toISOString(),
        error: "上一轮仍在执行（overlapPolicy=skip）",
      })
      return undefined
    }
    let timeoutTimer: NodeJS.Timeout | undefined
    let timedOut = false
    const release = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      releaseExecutionLock(this.deps.directory, schedule.id)
    }
    try {
      const script = readWorkflowScript(this.deps.directory, schedule.workflowId)
      // fresh session：每 Run 独立顶层会话，agent 子树挂其下（B1 血统 root）
      const created = await this.deps.client.session.create({
        body: { title: `${schedule.name ?? schedule.workflowId} · ${slot.toISOString()}` },
      })
      if (created.error) {
        throw new Error(`session create 失败: ${JSON.stringify(created.error)}`)
      }
      const sessionId = created.data.id
      // 含 sessionId 的 base 供终态 Record 复用（onFinished 闭包）
      const runningBase: ScheduleRun = { ...base, sessionId }
      writeRecord(this.deps.directory, runningBase)
      const runId = this.deps.manager.start(
        {
          client: this.deps.client,
          parentSessionId: sessionId,
          directory: this.deps.directory,
          rootSessionId: sessionId,
        },
        {
          script,
          args: schedule.args,
          // checkpoint 即败（需求 17）：定时执行无人值守，无人工确认通道
          confirm: () =>
            Promise.reject(
              new Error(
                "INTERACTIVE_ACTION_REQUIRED：定时执行不支持 checkpoint 人工确认（无人值守），请在手动运行中确认或移除 checkpoint",
              ),
            ),
          trigger:
            trigger === "scheduled"
              ? { type: "schedule", scheduleId: schedule.id, scheduledAt: slot.toISOString() }
              : { type: "manual", scheduleId: schedule.id },
          onFinished: (info) => {
            release()
            this.writeTerminalRecord(runningBase, info, timedOut)
          },
        },
      )
      // timeout（需求 21）：到点 stop，复用 abort 级联；Record 量 timedOut 标志记 timeout 态
      if (schedule.timeoutMs && schedule.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          this.deps.manager.stop(runId)
        }, schedule.timeoutMs)
      }
      return runId
    } catch (error) {
      release()
      this.writeFailedRecord(base, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** 立即执行一次（schedule_run_now）：跳过时间判定与 claim（手动语义），走同一执行路径（含 execution lock） */
  async runNow(scheduleId: string): Promise<{ runId?: string; error?: string }> {
    const schedule = listSchedules(this.deps.directory).find((s) => s.id === scheduleId)
    if (!schedule) {
      return { error: `SCHEDULE_NOT_FOUND：未找到定时任务 "${scheduleId}"（可用 schedule_list 查看全部）` }
    }
    const runId = await this.execute(schedule, this.now(), "manual")
    if (!runId) {
      return { error: `启动失败（上一轮仍在执行，或 workflow 缺失；详情见执行记录）：scheduleId=${scheduleId}` }
    }
    return { runId }
  }

    /** BackgroundRunManager 终态 -> Record 终态（timeout 标志区分超时与失败） */
  private writeTerminalRecord(base: ScheduleRun, info: BackgroundRunInfo, timedOut: boolean): void {
    const status: ScheduleRunStatus = timedOut ? "timeout" : info.status === "completed" ? "success" : "failed"
    const okCount = info.records.filter((r) => r.status === "ok").length
    const tokens = info.records.reduce((acc, r) => acc + (r.tokens ?? 0), 0)
    const cost = info.records.reduce((acc, r) => acc + (r.cost ?? 0), 0)
    writeRecord(this.deps.directory, {
      ...base,
      workflowRunId: info.runId,
      status,
      finishedAt: new Date().toISOString(),
      durationMs: info.endedAt ? info.endedAt - new Date(base.startedAt).getTime() : undefined,
      tokens,
      cost: cost > 0 ? cost : undefined,
      result: info.status === "completed" ? `完成：${okCount}/${info.records.length} agent 成功` : undefined,
      error: timedOut
        ? `超过 timeoutMs 被 abort（${info.error ?? "timeout"}）`
        : info.status === "completed"
          ? undefined
          : info.error ?? `run ${info.status}`,
    })
  }

  /** 准备阶段失败（无 workflowRunId） */
  private writeFailedRecord(base: ScheduleRun, message: string): void {
    writeRecord(this.deps.directory, {
      ...base,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: message,
    })
  }
}
