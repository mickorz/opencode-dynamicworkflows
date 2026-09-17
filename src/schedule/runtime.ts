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
import { readWorkflowScript } from "./registry.js"
import { tryClaim, pruneClaims } from "./coordination.js"
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
      await this.execute(schedule, slot)
    }
  }

  /** 认领成功后的执行：fresh session -> 后台 run -> Record（终态由 onFinished 写）；返回 runId */
  private async execute(schedule: Schedule, slot: Date): Promise<string | undefined> {
    const startedAt = new Date().toISOString()
    const base: ScheduleRun = {
      scheduleId: schedule.id,
      workflowId: schedule.workflowId,
      status: "running",
      scheduledAt: slot.toISOString(),
      startedAt,
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
      return this.deps.manager.start(
        {
          client: this.deps.client,
          parentSessionId: sessionId,
          directory: this.deps.directory,
          rootSessionId: sessionId,
        },
        {
          script,
          args: schedule.args,
          onFinished: (info) => this.writeTerminalRecord(runningBase, schedule, info),
        },
      )
    } catch (error) {
      // 执行准备失败（workflow 缺失 / session 创建失败）：直接落 failed Record
      this.writeFailedRecord(base, schedule, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /** 立即执行一次（schedule_run_now）：跳过时间判定与 claim（手动语义），走同一执行路径 */
  async runNow(scheduleId: string): Promise<{ runId?: string; error?: string }> {
    const schedule = listSchedules(this.deps.directory).find((s) => s.id === scheduleId)
    if (!schedule) {
      return { error: `SCHEDULE_NOT_FOUND：未找到定时任务 "${scheduleId}"（可用 schedule_list 查看全部）` }
    }
    const runId = await this.execute(schedule, this.now())
    if (!runId) {
      return { error: `启动失败（详情见 Record 或 workflow 是否缺失）：scheduleId=${scheduleId}` }
    }
    return { runId }
  }

    /** BackgroundRunManager 终态 -> Record 终态 */
  private writeTerminalRecord(base: ScheduleRun, _schedule: Schedule, info: BackgroundRunInfo): void {
    const status: ScheduleRunStatus = info.status === "completed" ? "success" : "failed"
    const okCount = info.records.filter((r) => r.status === "ok").length
    writeRecord(this.deps.directory, {
      ...base,
      workflowRunId: info.runId,
      status,
      finishedAt: new Date().toISOString(),
      result: info.status === "completed" ? `完成：${okCount}/${info.records.length} agent 成功` : undefined,
      error: info.status === "completed" ? undefined : info.error ?? `run ${info.status}`,
    })
  }

  /** 准备阶段失败（无 workflowRunId） */
  private writeFailedRecord(base: ScheduleRun, _schedule: Schedule, message: string): void {
    writeRecord(this.deps.directory, {
      ...base,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: message,
    })
  }
}
