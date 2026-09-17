/**
 * ScheduleService（P1 最小版：create + list）
 *
 * create：校验 cron 子集 -> 校验 workflowId 存在 -> 生成 id -> 落盘
 * list：配置 + lastRun（Record）+ nextRun + workflowMissing 聚合
 */

import { validateCron, nextRun } from "./cron.js"
import { loadRegistry } from "./registry.js"
import { listSchedules, getSchedule, saveSchedule } from "./store.js"
import { latestRecord } from "./record.js"
import type { Schedule, ScheduleView } from "./types.js"

export interface CreateScheduleInput {
  directory: string
  workflowId: string
  cron: string
  name?: string
  args?: Record<string, unknown>
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  const cronError = validateCron(input.cron)
  if (cronError) {
    throw new Error(`INVALID_CRON：${cronError}`)
  }
  const registry = loadRegistry(input.directory)
  if (!registry.has(input.workflowId)) {
    const known = Array.from(registry.keys()).join(", ") || "（目录为空或不存在）"
    throw new Error(
      `WORKFLOW_NOT_FOUND：未找到 workflowId "${input.workflowId}"（.opencode-workflows/workflows/，已知 id：${known}）`,
    )
  }
  let id = `sch-${input.workflowId}-${Date.now().toString(36)}`
  let seq = 1
  while (getSchedule(input.directory, id)) {
    id = `sch-${input.workflowId}-${Date.now().toString(36)}-${seq++}`
  }
  const now = new Date().toISOString()
  const schedule: Schedule = {
    id,
    name: input.name,
    workflowId: input.workflowId,
    cron: input.cron,
    enabled: true,
    args: input.args,
    createdAt: now,
    updatedAt: now,
  }
  saveSchedule(input.directory, schedule)
  return schedule
}

/** 列表视图：配置 + lastRun + nextRun + workflowMissing */
export function listScheduleViews(directory: string): ScheduleView[] {
  const registry = loadRegistry(directory)
  const now = new Date()
  return listSchedules(directory).map((schedule) => {
    const last = latestRecord(directory, schedule.id)
    return {
      ...schedule,
      lastRunAt: last?.startedAt,
      lastRunStatus: last?.status,
      nextRunAt: schedule.enabled ? nextRun(schedule.cron, now).toISOString() : undefined,
      workflowMissing: !registry.has(schedule.workflowId),
    }
  })
}
