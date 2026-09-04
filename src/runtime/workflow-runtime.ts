/**
 * Workflow Runtime —— 宿主无关的编排核心（移植自 pi-dynamic-workflows src/workflow.ts，v0.1 精简面）
 *
 * 执行流程：
 *  runWorkflow(script, options)
 *   -> parseWorkflowScript 校验 meta 信封 + 剥离
 *   -> 注入运行时全局：agent / parallel / pipeline / phase / log / args / console
 *   -> runScriptInVm（DETERMINISM_PRELUDE + body）
 *        -> agent() 依次经过：abort 检查 -> maxAgents 配额 -> limiter 排队
 *             -> withTimeout 包装 -> 可恢复错误重试 -> AgentSessionRunner.run（注入缝）
 *        -> parallel()/pipeline()：recoverable 失败塌缩为 null，non-recoverable 上抛
 *   -> 汇总 AgentRecord / logs / phases / token 用量 返回
 *
 * 与 Pi 的差异（v0.1 精简，均有需求文档决策依据）：
 *  - 不含 journal/resume、token budget、worktree、嵌套 workflow、verify/judgePanel 等（P1+）
 *  - 不含 fanoutScope 批量取消（ALS）：maxAgents 超限时该次调用直接抛错，已入队的兄弟调用仍会执行
 */

import { createLimiter } from "./semaphore.js"
import { parseWorkflowScript, runScriptInVm } from "./vm.js"
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js"
import type { AgentSessionRunner, AgentRunOptions } from "../agent/session-runner.js"
import type { AgentRecord, AgentUsage, JournalEntry, WorkflowRunResult } from "../types/index.js"
import { createHash } from "node:crypto"

/** 运行时最大并发（与 Claude Code / Pi 一致） */
export const MAX_CONCURRENCY = 16
/** 单次 run 的 agent 总数上限（与 Pi 一致，可被 options.maxAgents 覆盖） */
export const MAX_AGENTS_PER_RUN = 1000
/** 可恢复失败的最大自动重试次数（与 Pi 一致） */
export const MAX_AGENT_RETRIES = 3

/** 脚本内 agent() 的可选项（比 AgentRunOptions 少 signal/onUsage 等宿主注入项） */
export interface ScriptAgentOptions {
  label?: string
  phase?: string
  /** JSON Schema（对象字面量），走 OpenCode 原生 format: json_schema */
  schema?: Record<string, unknown>
  /** OpenCode agent 名：缺省 explore（只读分析型），写类任务显式传 general */
  agentType?: string
  /** "provider/modelId" 或裸 "modelId"；缺省用会话默认模型 */
  model?: string
  /** 模型分层名（small/medium/big 或自定义），经 resolveTier 解析为具体模型；优先级低于 model（P1-3） */
  tier?: string
  /** 本 agent 的超时毫秒数；null 表示不设硬超时 */
  timeoutMs?: number | null
  /** 本 agent 的重试次数（可恢复失败后） */
  retries?: number
}

export interface WorkflowRunOptions {
  /** 暴露给脚本的 args 全局 */
  args?: unknown
  /** 注入缝：真实实现为 OpenCodeSessionAdapter；测试注入 fake runner */
  agent: AgentSessionRunner
  concurrency?: number
  maxAgents?: number
  /** 整个 run 的外部中断信号（来自 tool context.abort） */
  signal?: AbortSignal
  /** run 级默认超时；null 表示无硬超时 */
  agentTimeoutMs?: number | null
  /** run 级默认重试次数 */
  agentRetries?: number
  runId?: string
  /** tier 名 -> "provider/modelId" 的解析器（由 tool 层从配置文件注入，测试可 fake；P1-3） */
  resolveTier?: (tier: string) => string | undefined
  /** resume：上一轮的 journal（key 为 runId:callIndex），未变前缀直接回放（P1-1） */
  resumeJournal?: Map<string, JournalEntry>
  /** 每个成功 live agent 完成后回调，调用方负责持久化（P1-1） */
  onAgentJournal?: (entry: JournalEntry & { key: string }) => void
}

interface RuntimeState {
  currentPhase?: string
  phases: string[]
  logs: string[]
  agents: AgentRecord[]
  callSeq: number
  /** 已告警过的未配置 tier（每 run 每 tier 只告警一次） */
  warnedTiers: Set<string>
  /** 首个未命中 journal 的 callIndex；其后所有调用一律 live 重跑（最长未变前缀语义，照搬 Pi） */
  firstMiss: number
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now()
  const { meta, body } = parseWorkflowScript(script)
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : null
  const runId = options.runId ?? `run-${started.toString(36)}`
  const agentRunner = options.agent
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  )
  const limiter = createLimiter(concurrency)

  const state: RuntimeState = {
    logs: [],
    // 声明了 meta.phases 时，首个 phase 之前的 agent 归入第一个声明的 phase
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    agents: [],
    callSeq: 0,
    warnedTiers: new Set(),
    firstMiss: Number.POSITIVE_INFINITY,
  }

  let agentCount = 0
  let aborted = false
  const isAborted = () => aborted || Boolean(options.signal?.aborted)
  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
    }
  }

  const log = (message: string) => {
    state.logs.push(String(message))
  }

  const phase = (title: string) => {
    state.currentPhase = title
    if (!state.phases.includes(title)) state.phases.push(title)
  }

  const ensureAgentCapacity = () => {
    if (agentCount >= maxAgents) {
      throw new WorkflowError(
        `agent 数量超限 (${agentCount}/${maxAgents})；提高 maxAgents 或拆分任务`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      )
    }
  }

  const defaultAgentLabel = (phaseTitle: string | undefined, index: number): string =>
    phaseTitle ? `${phaseTitle} agent ${index}` : `agent ${index}`

  const agent = (prompt: string, agentOptions: ScriptAgentOptions = {}): Promise<unknown> => {
    let call: Promise<unknown>
    if (typeof prompt !== "string" || !prompt.trim()) {
      call = Promise.reject(
        new WorkflowError("agent() 需要非空 prompt 字符串", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
          recoverable: false,
        }),
      )
    } else {
      call = agentImpl(prompt, agentOptions)
    }
    // 防"脚本忘了 await"的拒绝演变为 unhandledRejection
    call.catch(() => {})
    return call
  }

  const agentImpl = async (prompt: string, scriptOptions: ScriptAgentOptions): Promise<unknown> => {
    throwIfAborted()
    ensureAgentCapacity()

    const assignedPhase = scriptOptions.phase ?? state.currentPhase
    // 模型优先级：显式 model > tier（经 resolveTier）> 会话默认（P1-3）
    let modelSpec = scriptOptions.model
    if (!modelSpec && scriptOptions.tier) {
      const resolved = options.resolveTier?.(scriptOptions.tier)
      if (resolved) {
        modelSpec = resolved
      } else if (!state.warnedTiers.has(scriptOptions.tier)) {
        state.warnedTiers.add(scriptOptions.tier)
        log(
          `tier "${scriptOptions.tier}" 未配置，回退会话默认模型；配置见 ~/.config/opencode/workflows/model-tiers.json 或项目 .opencode-workflows/model-tiers.json`,
        )
      }
    }
    const callIndex = state.callSeq++
    agentCount++
    const label = scriptOptions.label?.trim() || defaultAgentLabel(assignedPhase, agentCount)

    const record: AgentRecord = {
      id: `${runId}:${callIndex}`,
      label,
      phase: assignedPhase,
      status: "running",
    }
    state.agents.push(record)
    const agentStarted = Date.now()

    // ---- journal / resume（P1-1）：确定性哈希 + 最长未变前缀回放 ----
    // 哈希身份：prompt/model/phase/agentType/schema（与 Pi 同思路，无 thread/agentDef/tier 面）
    const deltaKey = `${runId}:${callIndex}`
    const callHash = hashAgentCall(prompt, scriptOptions, assignedPhase)
    const cached = options.resumeJournal?.get(deltaKey)
    const hashMatches = cached != null && cached.hash === callHash
    // 空文本结果不回放：历史 journal 里的空串一律重跑（与 Pi isEmptyTextAgentResult 同语义）
    const cachedEmpty = hashMatches && isEmptyTextResult(cached.result, scriptOptions.schema)
    if (hashMatches && !cachedEmpty && callIndex < state.firstMiss) {
      record.status = "ok"
      record.replayed = true
      record.model = cached.model
      return cached.result
    }
    if (!hashMatches || cachedEmpty) {
      state.firstMiss = Math.min(state.firstMiss, callIndex)
    }

    return limiter(async () => {
      const timeout = scriptOptions.timeoutMs !== undefined ? scriptOptions.timeoutMs : agentTimeoutMs
      const retries = normalizeAgentRetries(scriptOptions.retries ?? options.agentRetries ?? 0)
      const maxAttempts = retries + 1

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted()
        // 每次 attempt 一个独立 controller：超时只取消本次，run 级 abort 取消所有
        const attemptController = new AbortController()
        const onRunAbort = () => attemptController.abort()
        options.signal?.addEventListener("abort", onRunAbort)
        try {
          const runOptions: AgentRunOptions = {
            label,
            phase: assignedPhase,
            agentType: scriptOptions.agentType,
            model: modelSpec,
            schema: scriptOptions.schema,
            signal: attemptController.signal,
            onUsage: (usage: AgentUsage) => {
              record.tokens = (record.tokens ?? 0) + (usage.total ?? 0)
            },
          }
          const value = await withTimeout(agentRunner.run(prompt, runOptions), timeout, label, () =>
            attemptController.abort(),
          )
          record.status = "ok"
          record.durationMs = Date.now() - agentStarted
          record.model = modelSpec
          // 成功且非空结果写入 journal 回调；失败/null/空文本不进（与 Pi 一致）
          if (!isEmptyTextResult(value, scriptOptions.schema)) {
            options.onAgentJournal?.({ key: deltaKey, hash: callHash, result: value, model: modelSpec })
          }
          return value
        } catch (error) {
          if (isAborted()) {
            record.status = "aborted"
            record.durationMs = Date.now() - agentStarted
            throw wrapError(error)
          }
          const workflowError = wrapError(error)
          if (!workflowError.recoverable) {
            record.status = "failed"
            record.error = workflowError.message
            record.durationMs = Date.now() - agentStarted
            throw workflowError
          }
          if (attempt >= maxAttempts) {
            record.status = "failed"
            record.error = workflowError.message
            record.durationMs = Date.now() - agentStarted
            log(`agent "${label}" ${maxAttempts} 次尝试后失败: ${workflowError.code} ${workflowError.message}`)
            return null
          }
          log(`agent "${label}" 第 ${attempt} 次尝试失败，重试: ${workflowError.message}`)
        } finally {
          options.signal?.removeEventListener("abort", onRunAbort)
        }
      }
      return null
    })
  }

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted()
    if (!Array.isArray(thunks)) throw new TypeError("parallel() 期望函数数组")
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() 期望函数数组而非 Promise 数组，请用 () => agent(...) 包裹")
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk()
        } catch (error) {
          if (isAborted()) throw error
          const workflowError = wrapError(error)
          // 不可恢复失败（脚本校验错/agent 超限）终止整个 run，不塌缩为 null
          if (!workflowError.recoverable) throw workflowError
          log(`parallel[${index}] 失败: ${workflowError.message}`)
          return null
        }
      }),
    )
  }

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted()
    if (!Array.isArray(items)) throw new TypeError("pipeline() 第一个参数必须是数组")
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() 的每个 stage 必须是函数: pipeline(items, item => ..., result => ...)")
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          try {
            throwIfAborted()
            value = await stage(value, item, index)
            throwIfAborted()
          } catch (error) {
            if (isAborted()) throw error
            const workflowError = wrapError(error)
            if (!workflowError.recoverable) throw workflowError
            log(`pipeline[${index}] 失败: ${workflowError.message}`)
            return null
          }
        }
        return value
      }),
    )
  }

  const consoleShim = {
    log,
    info: log,
    warn: (m: unknown) => log(`[warn] ${String(m)}`),
    error: (m: unknown) => log(`[error] ${String(m)}`),
  }

  const globals: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    phase,
    log,
    args: options.args,
    console: consoleShim,
  }

  let result: unknown
  try {
    result = await runScriptInVm(body, meta.name, globals)
  } catch (error) {
    aborted = true
    throw error
  }

  if (agentCount === 0) {
    throw new WorkflowError(
      "workflow 脚本必须至少调用一次 agent()；纯计算请直接在对话中完成，不要用 workflow",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    )
  }

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agents: state.agents,
    agentCount,
    durationMs: Date.now() - started,
    runId,
  }
}

/** 带超时的 Promise 竞争；onTimeout 在拒绝生效前触发，用于取消底层工作（照搬 Pi withTimeout） */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise

  let timeoutId: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // 尽力清理，不掩盖超时错误
      }
      reject(
        new WorkflowError(
          `agent "${label}" 超时 (${ms}ms)；调大或省略 timeoutMs 允许更长运行`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      )
    }, ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1
  return Math.min(MAX_CONCURRENCY, Math.floor(value))
}

/**
 * agent 调用的稳定身份哈希（P1-1，照搬 Pi hashAgentCall 思路）。
 * 身份面 = prompt / model spec / tier / phase / agentType / schema，sha256 后十六进制。
 * 注意：model/tier 只取脚本声明的 spec（与 Pi 一致，resolveTier 解析结果不进哈希，换 tier 配置不破缓存）。
 */
function hashAgentCall(prompt: string, options: ScriptAgentOptions, phase: string | undefined): string {
  const identity = JSON.stringify({
    prompt,
    model: options.model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    schema: options.schema ?? null,
  })
  return createHash("sha256").update(identity).digest("hex")
}

/** 无 schema 且结果为空/纯空白字符串 → 视为空文本（不 journal、不回放） */
function isEmptyTextResult(result: unknown, schema: Record<string, unknown> | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value))
}
