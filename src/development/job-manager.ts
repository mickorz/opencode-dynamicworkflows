/**
 * DevJobManager —— Development Job 生命周期管理（P2 + P3）
 *
 * 类头流程图：
 *
 *  业务 Run 完成 development true
 *        |
 *        v
 *  createOnce 幂等检查 同一 runId 只创建一次
 *        |
 *        v
 *  startOptimizer 预计算分析
 *    P3 analyzeRun 确定性分析
 *      -> 成功 写 report.md + proposals.json
 *      -> 失败 记录 analysisStatus=failed
 *        |
 *        v
 *  分支决策
 *    A 成功 -> Optimizer Agent 审阅预写报告
 *    B1 失败+History可用 -> Optimizer Agent 自行分析
 *    B2 失败+History不可用 -> 记录失败不启动
 *        |
 *        v
 *  onFinished 回调 更新 Job 状态
 *  completed 或 failed
 *        |
 *        v
 *  persist 持久化到 development jobs json
 *
 * 插件重启恢复：
 *  load 时 running 标为 failed 服务端被杀
 *  load 时 pending 重新启动
 *
 * 约束：
 *  - Job 创建失败不阻断业务 Run 终态
 *  - Optimizer Run 的失败不改变已成功业务 Workflow 的状态
 *  - 不使用 console log error CLAUDE MD 约束
 *  - src/development/ 禁止 import SDK（AGENTS.md 架构约束）
 */

import fs from "node:fs"
import path from "node:path"
import type { BackgroundRunManager } from "../tools/background-runs.js"
import { OPTIMIZER_SCRIPT } from "./optimizer-script.js"
import type { DevJob, DevJobFile, CreateOnceInput } from "./types.js"
import type { AgentRecord } from "../types/index.js"
import { TraceStore } from "../trace/store.js"
import { analyzeRun } from "./analyzer/index.js"
import type { AnalysisResult } from "./analyzer/index.js"

const DEV_DIR = path.join(".opencode-workflows", "development")
const JOBS_FILE = "jobs.json"

/**
 * P3.2: 统一的 Job Key 生成函数
 * 有 runAttemptId 时用复合键（Resume 可独立），无则回退到 runId
 */
export function makeJobKey(runId: string, runAttemptId?: string): string {
  return runAttemptId ? `${runId}:${runAttemptId}` : runId
}

export class DevJobManager {
  private readonly background: BackgroundRunManager
  private jobs = new Map<string, DevJob>()

  constructor(background: BackgroundRunManager) {
    this.background = background
  }

  /** 启动时加载持久化 Job 状态并恢复 */
  load(directory: string): void {
    const file = path.join(directory, DEV_DIR, JOBS_FILE)
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DevJobFile
      for (const job of raw.jobs ?? []) {
        if (job.status === "running") {
          job.status = "failed"
          job.error = "插件重启时被中断"
          job.endedAt = Date.now()
        }
        // P3.2: 用 makeJobKey 恢复 Map Key（与 createOnce 一致）
        this.jobs.set(makeJobKey(job.runId, job.runAttemptId), job)
      }
      this.persist(directory)
      for (const job of this.jobs.values()) {
        if (job.status === "pending") {
          void this.retryPending(job, directory)
        }
      }
    } catch {
      // 文件不存在或解析失败：首次启动
    }
  }

  /** 幂等创建 Optimizer Job（P3.2: 按 runId+runAttemptId 去重，Resume 可独立分析） */
  createOnce(input: CreateOnceInput): DevJob | undefined {
    const dedupKey = makeJobKey(input.runId, input.runAttemptId)
    const existing = this.jobs.get(dedupKey)
    if (existing) return existing

    const job: DevJob = {
      runId: input.runId,
      runAttemptId: input.runAttemptId,
      originRunId: input.originRunId,
      status: "pending",
      createdAt: Date.now(),
      historyPath: input.historyPath,
    }
    this.jobs.set(dedupKey, job)
    this.persist(input.directory)

    this.startOptimizer(job, input)
    return job
  }

  /** 查询全部 Job */
  list(): DevJob[] {
    return Array.from(this.jobs.values())
  }

  /** 启动 Optimizer（P3: 预计算 + 分支决策） */
  private startOptimizer(job: DevJob, input: CreateOnceInput): void {
    // P3: 预计算结构化分析
    let analysisResult: AnalysisResult | undefined
    const generatedAt = Date.now()

    try {
      const store = new TraceStore(input.directory)
      // P3.2: 用 runAttemptId 定位 attempt 目录（Resume 隔离）
      const attemptId = job.runAttemptId ?? input.runAttemptId
      const manifest = store.readManifest(job.originRunId, attemptId)
      if (!manifest) throw new Error("manifest not found")
      if (manifest.sessions.length === 0) throw new Error("manifest has no sessions")

      // 预计算分析
      const agents: AgentRecord[] = input.agents ?? []
      analysisResult = analyzeRun(store, job.originRunId, manifest, agents, generatedAt, attemptId)
    } catch (e) {
      // 确定性分析失败：记录状态，不静默吞错
      analysisResult = {
        runId: job.originRunId,
        runAttemptId: "",
        ruleResults: {
          repeats: [],
          retries: [],
          dependencies: [],
          latency: { agents: [], totalMs: 0 },
          scriptExtractions: [],
        },
        proposals: [],
        overallIntegrity: "missing",
        generatedAt,
        analysisMode: "deterministic",
        analysisStatus: "failed",
        errorCode: e instanceof Error ? e.constructor.name : "Unknown",
        errorMessage: e instanceof Error ? e.message : String(e),
      }
      // 不预写报告文件：report.md/proposals.json 不存在
    }

    // 分支决策
    const deterministicOk = analysisResult.analysisStatus === "completed"

    if (deterministicOk) {
      // 分支 A：确定性分析成功
      // Optimizer Agent 读取预写报告，只做审阅和增补
      this.startOptimizerReview(job, input, analysisResult, "deterministic-success")
    } else {
      // 分支 B：确定性分析失败
      const historyAvailable = this.checkHistoryAvailable(job.originRunId, input.directory, job.runAttemptId ?? input.runAttemptId)
      if (historyAvailable) {
        // 分支 B1：History 可用，进入独立 LLM 分析分支
        this.startOptimizerReview(job, input, analysisResult, "llm-fallback")
      } else {
        // 分支 B2：History 不可用，记录失败，不启动缺乏证据的分析
        job.status = "failed"
        job.error = `Deterministic analysis failed and history unavailable: ${analysisResult.errorMessage}`
        job.endedAt = Date.now()
        this.persist(input.directory)
      }
    }
  }

  /** 启动 Optimizer 审阅 Run */
  private startOptimizerReview(
    job: DevJob,
    input: CreateOnceInput,
    analysisResult: AnalysisResult,
    reviewMode: "deterministic-success" | "llm-fallback",
  ): void {
    try {
      const optimizerRunId = this.background.start(
        {
          client: input.client,
          parentSessionId: input.parentSessionId,
          directory: input.directory,
          rootSessionId: input.rootSessionId,
        },
        {
          script: OPTIMIZER_SCRIPT,
          args: {
            originRunId: job.originRunId,
            historyPath: job.historyPath,
            reviewMode,
            analysisMode: analysisResult.analysisMode,
            analysisStatus: analysisResult.analysisStatus,
            proposalCount: analysisResult.proposals.length,
            ...(analysisResult.errorMessage ? { analysisError: analysisResult.errorMessage } : {}),
          },
          development: false,
          developmentForbidden: true,
          trigger: { type: "development-optimizer" },
          onFinished: (info) => {
            // P3.2: 用复合键查找 Job（与 createOnce 一致）
            const jobKey = makeJobKey(job.runId, job.runAttemptId)
            this.onOptimizerFinished(jobKey, input.directory, info.status, info.error)
          },
        },
      )
      job.optimizerRunId = optimizerRunId
      job.status = "running"
      job.startedAt = Date.now()
      this.persist(input.directory)
    } catch (e) {
      job.status = "failed"
      job.error = e instanceof Error ? e.message : String(e)
      job.endedAt = Date.now()
      this.persist(input.directory)
    }
  }

  /** 检查 History 是否可用（P3.2: 在 attempt 目录中检查 history.jsonl） */
  private checkHistoryAvailable(runId: string, directory: string, runAttemptId?: string): boolean {
    const store = new TraceStore(directory)
    const dir = store.runDir(runId, runAttemptId)
    const historyPath = path.join(dir, "history.jsonl")
    try {
      return fs.existsSync(historyPath) && fs.readFileSync(historyPath, "utf8").trim().length > 0
    } catch {
      return false
    }
  }

  /** 重试 pending Job（插件重启后） */
  private async retryPending(job: DevJob, directory: string): Promise<void> {
    // pending Job 无 CreateOnceInput 的 client 等参数，无法重启
    // 标记为 failed（第一版不自动重试 pending，需人工介入）
    if (job.status === "pending") {
      job.status = "failed"
      job.error = "重启后无法恢复 client 上下文"
      job.endedAt = Date.now()
      this.persist(directory)
    }
  }

  /** Optimizer Run 完成回调（P3.2: 用复合键查找 Job） */
  private onOptimizerFinished(
    jobKey: string,
    directory: string,
    status: string,
    error?: string,
  ): void {
    const job = this.jobs.get(jobKey)
    if (!job) return
    job.status = status === "completed" ? "completed" : "failed"
    if (error) job.error = error
    job.endedAt = Date.now()
    this.persist(directory)
  }

  /** 持久化到磁盘（原子写，同 JournalStore / TraceStore 范式） */
  private persist(directory: string): void {
    try {
      const dir = path.join(directory, DEV_DIR)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, JOBS_FILE)
      const data: DevJobFile = {
        version: 1,
        jobs: Array.from(this.jobs.values()),
      }
      const tmp = `${file}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
        try {
          fs.renameSync(tmp, file)
        } catch {
          fs.rmSync(file, { force: true })
          fs.renameSync(tmp, file)
        }
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
      }
    } catch {
      // 落盘失败不阻断
    }
  }
}
