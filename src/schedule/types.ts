/**
 * Schedule 领域类型（P1 · In-Process 调度）
 *
 * 对象关系：
 *  Schedule        = 用户配置（纯配置文件，运行时不写入）
 *  TriggerClaim    = 某个 slot 是否已被接管（兼持久化游标，epoch 文件名）
 *  ExecutionLock   = 当前 Schedule 是否正在执行（Phase 3）
 *  ScheduleRun     = 一次真实执行记录（结果留档，fresh session 不回传后的唯一结果源）
 *  Session         = 某次 Run 的 Agent 会话（每 Run 独立创建）
 */

/** 定时任务配置（.opencode-workflows/schedules/<id>.json，纯配置，运行时只读） */
export interface Schedule {
  id: string
  /** 展示名；缺省用 workflowId */
  name?: string
  workflowId: string
  /** cron 子集四模式：每 n 分钟 / 每小时 m 分 / 每天 h 点 m 分 / 每周 W 的 h 点 m 分 */
  cron: string
  enabled: boolean
  /** 透传给 workflow 脚本的 args */
  args?: Record<string, unknown>
  /** 重叠策略（P1 仅 skip：上一轮还在跑时新轮跳过；Phase 3 生效） */
  overlapPolicy?: "skip"
  /** 单轮超时毫秒数（Phase 3 生效；到点 abort） */
  timeoutMs?: number
  createdAt: string
  updatedAt: string
}

/** 一次定时执行的记录（.opencode-workflows/runs/schedules/<scheduleId>/<ts>.json） */
export interface ScheduleRun {
  scheduleId: string
  workflowId: string
  /** BackgroundRunManager 的 runId（与 journal / workflow run 对齐） */
  workflowRunId?: string
  /** 本轮 fresh session 的 id（agent 子树挂其下） */
  sessionId?: string
  status: ScheduleRunStatus
  /** 触发时间槽（slot）ISO；run_now 时为手动触发时间 */
  scheduledAt?: string
  startedAt: string
  finishedAt?: string
  /** 结果摘要（如 N agents completed；详细数据在 journal） */
  result?: string
  error?: string
}

export type ScheduleRunStatus = "running" | "success" | "failed" | "timeout" | "skipped"

/** schedule_list / schedule_get 展示用聚合 */
export interface ScheduleView extends Schedule {
  /** 从最近一条 ScheduleRun 聚合 */
  lastRunAt?: string
  lastRunStatus?: ScheduleRunStatus
  /** 下一个未来 slot（本地时区计算） */
  nextRunAt?: string
  /** workflow 文件缺失标记 */
  workflowMissing?: boolean
}
