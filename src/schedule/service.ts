/**
 * ScheduleService（P1 最小版：create + list）
 *
 * create：校验 cron 子集 -> 校验 workflowId 存在 -> 生成 id -> 落盘
 * list：配置 + lastRun（Record）+ nextRun + workflowMissing 聚合
 */

import { validateCron, nextRun } from "./cron.js"
import { loadRegistry } from "../runtime/workflow-registry.js"
import { listSchedules, getSchedule, saveSchedule, deleteScheduleFile } from "./store.js"
import { latestRecord, listRecords } from "./record.js"
import type { Schedule, ScheduleRun, ScheduleView } from "./types.js"

export interface CreateScheduleInput {
  directory: string
  workflowId: string
  cron: string
  name?: string
  args?: Record<string, unknown>
  /** 创建即停用（缺省 true 启用） */
  enabled?: boolean
  /** 单轮超时毫秒数 */
  timeoutMs?: number
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
    enabled: input.enabled ?? true,
    args: input.args,
    timeoutMs: input.timeoutMs,
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

// ---------- 管理操作（Phase 2） ----------

function mustGet(directory: string, id: string): Schedule {
  const schedule = getSchedule(directory, id)
  if (!schedule) {
    throw new Error(`SCHEDULE_NOT_FOUND：未找到定时任务 "${id}"（可用 schedule_list 查看全部）`)
  }
  return schedule
}

/** 详情视图：配置 + 最近历史 */
export function getScheduleView(
  directory: string,
  id: string,
): ScheduleView & { history: ScheduleRun[] } {
  const schedule = mustGet(directory, id)
  const registry = loadRegistry(directory)
  const now = new Date()
  const last = latestRecord(directory, id)
  return {
    ...schedule,
    lastRunAt: last?.startedAt,
    lastRunStatus: last?.status,
    nextRunAt: schedule.enabled ? nextRun(schedule.cron, now).toISOString() : undefined,
    workflowMissing: !registry.has(schedule.workflowId),
    history: listRecords(directory, id, 5),
  }
}

export interface UpdateSchedulePatch {
  name?: string
  cron?: string
  args?: Record<string, unknown>
  timeoutMs?: number
  enabled?: boolean
}

/** 更新可变字段（仅 name/cron/args/timeoutMs/enabled）；workflowId 不可改（重建新 schedule） */
export function updateSchedule(directory: string, id: string, patch: UpdateSchedulePatch): Schedule {
  const schedule = mustGet(directory, id)
  if (patch.cron !== undefined && patch.cron !== schedule.cron) {
    const cronError = validateCron(patch.cron)
    if (cronError) throw new Error(`INVALID_CRON：${cronError}`)
  }
  if (patch.timeoutMs !== undefined && patch.timeoutMs <= 0) {
    throw new Error(`timeoutMs 需为正毫秒数，收到 ${patch.timeoutMs}`)
  }
  const updated: Schedule = {
    ...schedule,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
    ...(patch.args !== undefined ? { args: patch.args } : {}),
    ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: new Date().toISOString(),
  }
  saveSchedule(directory, updated)
  return updated
}

/** 启用/停用（保留配置，停用后不触发） */
export function setScheduleEnabled(directory: string, id: string, enabled: boolean): Schedule {
  return updateSchedule(directory, id, { enabled })
}

/** 删除 schedule 配置（不动 workflow 文件；claim 与历史 Record 保留，幂等记录无害） */
export function removeSchedule(directory: string, id: string): void {
  mustGet(directory, id)
  if (!deleteScheduleFile(directory, id)) {
    throw new Error(`SCHEDULE_NOT_FOUND：删除失败，配置文件不存在 "${id}"`)
  }
}
