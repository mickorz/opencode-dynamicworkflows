/**
 * OptimizationJobManager —— 自优化任务生命周期管理（P4-A）
 *
 * 类头流程图：
 *
 *  runAggregationCycle 达标候选（distinctRunCount >= 2 且 patchEligible）
 *        |
 *        v
 *  createOnce 幂等检查（同步 Map + 同步落盘，单事件循环内原子）
 *    同 fingerprint + 同目标 Workflow：
 *      活跃态 -> 返回既有 Job（防重复触发）
 *      终态 -> 新 occurrence 数未增长则不创建（failed 重试门槛）
 *              增长且 attempt < 3 -> 新一轮 attempt + 1
 *    无 -> 创建 attempt = 1
 *        |
 *        v
 *  persist 到 development optimization-jobs json
 *        |
 *        v
 *  updateState 状态机推进（P4-B/C/D 各阶段调用）
 *    进入终态时记录 finishedOccurrenceCount（下一轮重试门槛）
 *
 * 约束（P4 执行文档 三 / 4.0.5）：
 *  - Job 粒度 = (candidateFingerprint, 目标 Workflow)（P0-1：Patch 按目标分离）
 *  - optimizationAttempt 上限 3
 *  - failed 候选需新 Run 产生新 occurrence 才能重试
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  makeOptimizationId,
  isActiveOptimizationState,
  type OptimizationJob,
  type OptimizationJobState,
} from "./optimization-job.js"

export type { OptimizationJob, OptimizationJobState }

/** optimizationAttempt 上限（文档：从 1 开始，上限 3） */
const MAX_ATTEMPT = 3

/** token 预算缺省值（单候选整个优化周期的累计真实用量上限） */
const DEFAULT_TOKEN_BUDGET = 500_000

interface OptimizationJobsFile {
  schemaVersion: 1
  jobs: OptimizationJob[]
}

/** createOnce 输入 */
export interface CreateOptimizationJobInput {
  candidateFingerprint: string
  targetWorkflowPath: string
  targetWorkflowHash: string
  /** 该目标 Workflow 组内的独立 Run 数（终态重试门槛用） */
  distinctRunCount: number
  title?: string
  tokenBudget?: number
}

export class OptimizationJobManager {
  private readonly jobs = new Map<string, OptimizationJob>()

  /** 启动时加载持久化状态 */
  load(workflowsDir: string): void {
    const file = join(workflowsDir, "development", "optimization-jobs.json")
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as OptimizationJobsFile
      for (const job of raw.jobs ?? []) this.jobs.set(job.optimizationId, job)
    } catch {
      // 文件不存在或损坏：首次启动，从空开始
    }
  }

  persist(workflowsDir: string): void {
    const dir = join(workflowsDir, "development")
    mkdirSync(dir, { recursive: true })
    const data: OptimizationJobsFile = { schemaVersion: 1, jobs: Array.from(this.jobs.values()) }
    writeFileSync(join(dir, "optimization-jobs.json"), JSON.stringify(data, null, 2), "utf8")
  }

  list(): OptimizationJob[] {
    return Array.from(this.jobs.values())
  }

  /** 处于活跃态的 fingerprint 集合（聚合时排除，防重复触发） */
  activeFingerprints(): string[] {
    return this.list()
      .filter((j) => isActiveOptimizationState(j.state))
      .map((j) => j.candidateFingerprint)
  }

  get(optimizationId: string): OptimizationJob | undefined {
    return this.jobs.get(optimizationId)
  }

  /**
   * 幂等创建：
   *  - 同 (fingerprint, 目标 Workflow) 活跃态 -> 返回既有
   *  - 终态且无新独立 Run（distinctRunCount 未增长） -> undefined（failed 重试门槛）
   *  - 终态且 attempt 达上限 -> undefined
   *  - 其余 -> 新一轮 Job（attempt + 1）
   */
  createOnce(input: CreateOptimizationJobInput): OptimizationJob | undefined {
    const existing = this.list().filter(
      (j) =>
        j.candidateFingerprint === input.candidateFingerprint &&
        j.targetWorkflowPath === input.targetWorkflowPath,
    )
    if (existing.length > 0) {
      const active = existing.find((j) => isActiveOptimizationState(j.state))
      if (active) return active

      const latest = existing.reduce((acc, cur) => (cur.optimizationAttempt >= acc.optimizationAttempt ? cur : acc))
      if (latest.optimizationAttempt >= MAX_ATTEMPT) return undefined
      const finishedRuns = latest.finishedDistinctRunCount ?? 0
      if (input.distinctRunCount <= finishedRuns) return undefined

      const job = this.buildJob(input, latest.optimizationAttempt + 1)
      this.jobs.set(job.optimizationId, job)
      return job
    }

    const job = this.buildJob(input, 1)
    this.jobs.set(job.optimizationId, job)
    return job
  }

  private buildJob(input: CreateOptimizationJobInput, attempt: number): OptimizationJob {
    return {
      optimizationId: makeOptimizationId(input.candidateFingerprint, input.targetWorkflowHash, attempt),
      candidateFingerprint: input.candidateFingerprint,
      targetWorkflowPath: input.targetWorkflowPath,
      targetWorkflowHash: input.targetWorkflowHash,
      optimizationAttempt: attempt,
      totalTokenUsed: 0,
      tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      state: "aggregated",
      lastUpdatedTs: Date.now(),
      ...(input.title ? { title: input.title } : {}),
    }
  }

  /**
   * 状态机推进（P4-B/C/D 各阶段调用）
   * 进入终态时传 distinctRunCountOfTarget，记录 finishedDistinctRunCount 作为下一轮重试门槛
   */
  updateState(
    optimizationId: string,
    state: OptimizationJobState,
    patch: {
      candidateScriptHash?: string
      abResultHash?: string
      totalTokenUsed?: number
      /** 终态时该目标 Workflow 组内的独立 Run 数 */
      distinctRunCountOfTarget?: number
    } = {},
  ): boolean {
    const job = this.jobs.get(optimizationId)
    if (!job) return false
    job.state = state
    job.lastUpdatedTs = Date.now()
    if (patch.candidateScriptHash !== undefined) job.candidateScriptHash = patch.candidateScriptHash
    if (patch.abResultHash !== undefined) job.abResultHash = patch.abResultHash
    if (patch.totalTokenUsed !== undefined) job.totalTokenUsed = patch.totalTokenUsed
    const terminal = state === "applied" || state === "rejected" || state === "failed"
    if (terminal && patch.distinctRunCountOfTarget !== undefined) {
      job.finishedDistinctRunCount = patch.distinctRunCountOfTarget
    }
    return true
  }
}
