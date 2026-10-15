/**
 * Development Job 类型定义（P2）
 *
 * DevJob：一次自动优化任务的生命周期记录
 * DevJobFile：持久化文件形状（.opencode-workflows/development/jobs.json）
 *
 * 宿主无关：不依赖 SDK
 */

/** Development Job 的状态 */
export type DevJobStatus = "pending" | "running" | "completed" | "failed"

/** 单个 Development Job 记录 */
export interface DevJob {
  /** 业务 Run 的 runId（幂等键） */
  runId: string
  /** 触发本次优化的业务 Run ID */
  originRunId: string
  /** Optimizer Run 的 runId（BackgroundRunManager 分配） */
  optimizerRunId?: string
  status: DevJobStatus
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** 失败原因 */
  error?: string
  /** History 目录路径 */
  historyPath: string
}

/** 持久化文件形状（.opencode-workflows/development/jobs.json） */
export interface DevJobFile {
  version: 1
  jobs: DevJob[]
}

/** DevJobManager 创建 Job 的输入 */
export interface CreateOnceInput {
  runId: string
  originRunId: string
  /** P3.1: Run 执行轮次 ID（Resume 场景同一 runId 有不同 runAttemptId，用于独立去重） */
  runAttemptId?: string
  directory: string
  historyPath: string
  /** SDK client（由调用方传入，tools 层合法触碰 SDK） */
  client: import("../adapters/opencode-session-adapter.js").ClientLike
  parentSessionId: string
  rootSessionId: string
  /** P3: 真实 AgentRecord 数组（分析器用，缺失时标 unknown） */
  agents?: import("../types/index.js").AgentRecord[]
}
