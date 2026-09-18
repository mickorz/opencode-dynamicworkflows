/**
 * Workflow Runtime —— 宿主无关的编排核心（Native Composition 版）
 *
 * 执行流程：
 *  runWorkflow(script, options)  对外签名不变（tool 层/测试零改动）
 *   -> createSharedRunContext + createRootScope
 *   -> executeWorkflow(script, args, shared, scope)
 *        -> parseWorkflowScript 校验 meta 信封 + 剥离
 *        -> createWorkflowGlobals(shared, scope, args)：每次 invocation 独立 globals/args
 *        -> runScriptInVm（DETERMINISM_PRELUDE + body）
 *             -> agent() 依次经过：abort 检查 -> maxAgents 配额 -> scheduler 排队
 *                  -> withTimeout 包装 -> 可恢复错误重试 -> AgentSessionRunner.run（注入缝）
 *             -> workflow() 原语：同步阶段 childSeq++ 领号 -> canonical 路径 + 自环/深度检查
 *                  -> structuredClone 边界 -> 同 shared 下 executeWorkflow（不占 scheduler slot）
 *             -> parallel()/pipeline()：recoverable 失败塌缩为 null，non-recoverable 上抛
 *   -> 汇总 AgentRecord / logs / phases / token 用量 返回
 *
 * 一 Run 多 Scope（v0.8 设计，Docs/01_需求与规划/Native子工作流workflow原语执行计划.md）：
 *  - SharedRunContext 共享：scheduler（仅限 agent dispatch）/ maxAgents / abort / agents / logs / phases / journal
 *  - WorkflowScope 私有：currentPhase / callSeq / childSeq / firstMiss / args / globals
 *  - 三身份：name（定义 meta.name）/ label（实例 UI 名）/ keySegment（journal wfN，childSeq 生成）
 *  - journal key：root 为 runId:N（旧格式兼容），child 为 runId:wfK:N
 */

import fs from "node:fs"
import path from "node:path"
import { createLimiter } from "./semaphore.js"
import { parseWorkflowScript, runScriptInVm } from "./vm.js"
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js"
import { createWorktree, removeWorktree, type WorktreeInfo } from "../isolation/worktree.js"
import type { AgentSessionRunner, AgentRunOptions } from "../agent/session-runner.js"
import type {
  AgentRecord,
  AgentExecutionRecord,
  AgentUsage,
  JournalEntry,
  WorkflowExecutionRecord,
  WorkflowRunResult,
} from "../types/index.js"
import { buildOutputPreview, truncatePromptForJournal } from "./agent-result.js"
import { createHash } from "node:crypto"
import { loadRegistry, workflowsDir } from "./workflow-registry.js"

/** 运行时最大并发（与 Claude Code / Pi 一致） */
export const MAX_CONCURRENCY = 16
/** 单次 run 的 agent 总数上限（与 Pi 一致，可被 options.maxAgents 覆盖） */
export const MAX_AGENTS_PER_RUN = 1000
/** 可恢复失败的最大自动重试次数（与 Pi 一致） */
export const MAX_AGENT_RETRIES = 3
/** 子 workflow 嵌套深度上限（P1：仅一层 child） */
export const MAX_WORKFLOW_DEPTH = 1

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
  /** worktree 隔离：独立 git worktree 中运行，互不覆盖；失败静默降级共享目录（P1-5） */
  isolation?: "worktree"
}

/** workflow() 的 ref：字符串快捷方式或对象形式（label 为实例显示名） */
export type WorkflowRef = string | { scriptPath: string; label?: string }

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
  /** resume：上一轮的 journal（root key 为 runId:callIndex，child key 为 runId:wfK:callIndex） */
  resumeJournal?: Map<string, JournalEntry>
  /** 每个成功 live agent 完成后回调，调用方负责持久化（P1-1） */
  onAgentJournal?: (entry: JournalEntry & { key: string }) => void
  /** checkpoint() 的人工确认通道（tool 层接 ToolContext.ask；缺省走 headless default，P1-4） */
  confirm?: (promptText: string) => Promise<unknown>
  /** 项目基准目录（worktree 隔离的 base；缺省 process.cwd()，P1-5） */
  cwd?: string
  /** agent 记录到达终态（ok/failed/aborted，含缓存回放）时回调（P2 后台进度用） */
  onAgentUpdate?: (record: AgentRecord) => void
  /** 每个 attempt 到达失败/中止终态时回调（FR-7 执行历史）；payload 绝不携带 hash/result，落盘不影响 resume */
  onAgentExecution?: (payload: { key: string; execution: AgentExecutionRecord }) => void
  /** 触发来源元数据（需求 26 Observability：manual / schedule / webhook...）；写入 run 日志首行 */
  trigger?: {
    type: string
    scheduleId?: string
    scheduledAt?: string
  }
}

/** checkpoint() 的可选项（P1-4，仅确认型：OpenCode 无自由文本 UI 通道） */
export interface CheckpointOptions {
  /** 无人工通道（headless）时的回复；缺省 true */
  default?: unknown
  /** "abort"：headless 时抛错终止而非取 default */
  headless?: "default" | "abort"
}

/** 并发闸门封装：limiter 与 concurrency 两份状态不可能失同步；仅 agent dispatch 进入 */
export interface SharedScheduler {
  /** 唯一的并发入口：只包 agent() dispatch；workflow/phase/parallel 等编排原语永远不进入（死锁防线） */
  run<T>(task: () => Promise<T>): Promise<T>
  getConcurrency(): number
  setConcurrency(value: number): void
}

function createSharedScheduler(initial: number, onChange: (from: number, to: number) => void): SharedScheduler {
  let concurrency = initial
  const limiter = createLimiter(initial)
  return {
    run: (task) => limiter(task),
    getConcurrency: () => concurrency,
    setConcurrency(value) {
      const next = Math.min(MAX_CONCURRENCY, value)
      if (next !== concurrency) {
        const from = concurrency
        concurrency = next
        limiter.setLimit(next)
        onChange(from, next)
      }
    },
  }
}

/** 整棵 run（root + 全部 child scope）共享的资源层 */
interface SharedRunContext {
  runId: string
  scheduler: SharedScheduler
  maxAgents: number
  /** 实际 agent dispatch 计数（root 级配额，含 child 与 checkpoint） */
  agentCount: number
  /** 脚本异常即置位：与外部 signal 一起构成整 run 中止面 */
  aborted: boolean
  signal?: AbortSignal
  agentRunner: AgentSessionRunner
  /** 汇总面（root run 的结果字段） */
  agents: AgentRecord[]
  logs: string[]
  phases: string[]
  /** 全部 workflow invocation 执行记录（含 root；v0.9 Observability） */
  workflows: WorkflowExecutionRecord[]
  warnedTiers: Set<string>
  agentTimeoutMs: number | null
  agentRetries?: number
  resolveTier?: (tier: string) => string | undefined
  confirm?: (promptText: string) => Promise<unknown>
  resumeJournal?: Map<string, JournalEntry>
  onAgentJournal?: (entry: JournalEntry & { key: string }) => void
  onAgentExecution?: (payload: { key: string; execution: AgentExecutionRecord }) => void
  onAgentUpdate?: (record: AgentRecord) => void
  cwd: string
  /** workflow 名字引用缓存（v0.10 Registry）：workflowId -> 脚本绝对路径；首查扫描 .opencode-workflows/workflows/，运行中不重扫（子脚本增删不影响进行中 run） */
  registryCache?: Map<string, string>
}

/** 单个 workflow invocation 的私有身份与游标 */
interface WorkflowScope {
  /** 定义身份：脚本 meta.name */
  name: string
  /** 实例身份 / UI 名：调用方 label 或 meta.name */
  label: string
  scriptPath?: string
  /** 规范化绝对路径（自环检查用） */
  canonicalPath?: string
  depth: number
  /** phase 显示前缀：child 为 "▸ <label> / "，root 为空 */
  phasePrefix: string
  currentPhase?: string
  /** scope 私有调用序号（agent / checkpoint / DSL 组合键） */
  callSeq: number
  /** scope 私有 child 创建计数：与 callSeq 严格分离（journal 稳定性关键） */
  childSeq: number
  /** journal key 段：root 为 undefined（旧格式兼容），child 为 wfN */
  keySegment?: string
  /** scope 私有回放边界：首个未命中 journal 的 callIndex */
  firstMiss: number
  parent?: WorkflowScope
  /** 展示身份链（label 数组；root 在 executeWorkflow 入口补 [meta.name]） */
  pathLabels?: string[]
  /** 稳定身份链（keySegment 数组；root 为 ["root"]） */
  pathKeys?: string[]
}

function createSharedRunContext(options: WorkflowRunOptions, runId: string): SharedRunContext {
  const shared: SharedRunContext = {
    runId,
    scheduler: undefined as never, // 下一行装配（闭包需要 shared.log）
    maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
    agentCount: 0,
    aborted: false,
    signal: options.signal,
    agentRunner: options.agent,
    agents: [],
    logs: [],
    phases: [],
    workflows: [],
    warnedTiers: new Set(),
    agentTimeoutMs: options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : null,
    agentRetries: options.agentRetries,
    resolveTier: options.resolveTier,
    confirm: options.confirm,
    resumeJournal: options.resumeJournal,
    onAgentJournal: options.onAgentJournal,
    onAgentExecution: options.onAgentExecution,
    onAgentUpdate: options.onAgentUpdate,
    cwd: options.cwd ?? process.cwd(),
  }
  const initial = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  )
  shared.scheduler = createSharedScheduler(initial, (from, to) => {
    shared.logs.push(`并发上限调整为 ${to}（原 ${from}）`)
  })
  return shared
}

/** journal key：root 保持 runId:N（旧 journal 兼容），child 为 runId:wfK:N */
function scopedKey(shared: SharedRunContext, scope: WorkflowScope, callIndex: number): string {
  return scope.keySegment ? `${shared.runId}:${scope.keySegment}:${callIndex}` : `${shared.runId}:${callIndex}`
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now()
  const runId = options.runId ?? `run-${started.toString(36)}`
  const shared = createSharedRunContext(options, runId)
  const rootScope: WorkflowScope = {
    name: "root",
    label: "root",
    depth: 0,
    phasePrefix: "",
    callSeq: 0,
    childSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  }
  // 触发来源首行日志（需求 26 Observability：区分 manual / schedule 等）
  if (options.trigger) {
    const t = options.trigger
    shared.logs.push(
      `trigger: ${t.type}${t.scheduleId ? ` schedule=${t.scheduleId}` : ""}${t.scheduledAt ? ` scheduledAt=${t.scheduledAt}` : ""}`,
    )
  }
  const { meta, result } = await executeWorkflow(script, options.args, shared, rootScope)
  // 纯编排合法：root run 级至少一次实际 dispatch（agent 含 child 内与 checkpoint）
  if (shared.agentCount === 0) {
    throw new WorkflowError(
      "workflow 脚本必须至少调用一次 agent()（或经 workflow() 子流程间接调用）；纯计算请直接在对话中完成，不要用 workflow",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    )
  }

  return {
    meta,
    result: result as T,
    logs: shared.logs,
    phases: shared.phases,
    agents: shared.agents,
    workflows: shared.workflows,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
  }
}

/** 单个 workflow invocation 的执行体：独立 globals/args，共享资源层 */
async function executeWorkflow(
  script: string,
  args: unknown,
  shared: SharedRunContext,
  scope: WorkflowScope,
): Promise<{ meta: ReturnType<typeof parseWorkflowScript>["meta"]; result: unknown }> {
  const { meta, body } = parseWorkflowScript(script)

  // 路径身份链（v0.9）：root 补 [meta.name]/["root"]；child 在创建时已继承父链
  if (!scope.parent) {
    scope.pathLabels = [meta.name]
    scope.pathKeys = ["root"]
  }
  // 本次 invocation 的执行记录（wall-clock 与 TUI 树源；root 也生成，作树顶）
  const wfRecord: WorkflowExecutionRecord = {
    workflowId: meta.id,
    name: meta.name,
    label: scope.label,
    keySegment: scope.keySegment ?? "root",
    displayPath: scope.pathLabels!,
    scopePath: scope.pathKeys!,
    startedAt: Date.now(),
    status: "running",
  }
  shared.workflows.push(wfRecord)

  // 初始 phase（声明 meta.phases 时，首个 phase 之前的 agent 归入第一个声明的 phase）
  const initialPhase = meta.phases?.[0]?.title
  if (initialPhase) {
    scope.currentPhase = initialPhase
    const display = scope.phasePrefix + initialPhase
    if (!shared.phases.includes(display)) shared.phases.push(display)
  }

  const log = (message: string) => {
    shared.logs.push(String(message))
  }
  const isAborted = () => shared.aborted || Boolean(shared.signal?.aborted)
  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
    }
  }

  const phase = (title: string) => {
    scope.currentPhase = title
    const display = scope.phasePrefix + title
    if (!shared.phases.includes(display)) shared.phases.push(display)
  }

  const ensureAgentCapacity = () => {
    if (shared.agentCount >= shared.maxAgents) {
      throw new WorkflowError(
        `agent 数量超限 (${shared.agentCount}/${shared.maxAgents})；提高 maxAgents 或拆分任务`,
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

    // 显示 phase（child 内带 "▸ label / " 前缀；hash 身份含前缀——child 与 root 的同 prompt 不混缓存）
    const assignedPhase = scriptOptions.phase ?? scope.currentPhase
    const displayPhase = scope.phasePrefix ? scope.phasePrefix + assignedPhase : assignedPhase
    // 模型优先级：显式 model > tier（经 resolveTier）> 会话默认（P1-3）
    let modelSpec = scriptOptions.model
    if (!modelSpec && scriptOptions.tier) {
      const resolved = shared.resolveTier?.(scriptOptions.tier)
      if (resolved) {
        modelSpec = resolved
      } else if (!shared.warnedTiers.has(scriptOptions.tier)) {
        shared.warnedTiers.add(scriptOptions.tier)
        log(
          `tier "${scriptOptions.tier}" 未配置，回退会话默认模型；配置见 ~/.config/opencode/workflows/model-tiers.json 或项目 .opencode-workflows/model-tiers.json`,
        )
      }
    }
    const callIndex = scope.callSeq++
    shared.agentCount++
    const label = scriptOptions.label?.trim() || defaultAgentLabel(assignedPhase, shared.agentCount)

    const record: AgentRecord = {
      id: scopedKey(shared, scope, callIndex),
      label,
      phase: displayPhase,
      status: "running",
      // 双身份（v0.9）：仅 child 填（root 的 agent 无此字段，旧数据兼容判断依据）
      ...(scope.parent ? { workflowPath: scope.pathLabels!, workflowScopePath: scope.pathKeys! } : {}),
    }
    shared.agents.push(record)
    // 通知进行中状态：让后台 run 注册表能反映 running agent，进度展示才不会 done/total 永远相等
    shared.onAgentUpdate?.(record)
    const agentStarted = Date.now()

    // ---- journal / resume（P1-1）：确定性哈希 + 最长未变前缀回放 ----
    // 哈希身份：prompt/model/phase/agentType/schema（与 Pi 同思路，无 thread/agentDef/tier 面）
    const deltaKey = record.id
    const callHash = hashAgentCall(prompt, scriptOptions, displayPhase)
    const cached = shared.resumeJournal?.get(deltaKey)
    const hashMatches = cached != null && cached.hash === callHash
    // 空文本结果不回放：历史 journal 里的空串一律重跑（与 Pi isEmptyTextAgentResult 同语义）
    const cachedEmpty = hashMatches && isEmptyTextResult(cached.result, scriptOptions.schema)
    if (hashMatches && !cachedEmpty && callIndex < scope.firstMiss) {
      record.status = "ok"
      record.replayed = true
      record.model = cached.model
      // Node Inspector 元数据恢复：老 journal 无这些字段时为 undefined，读端容忍
      record.executionId = cached.executionId
      record.attempt = cached.attempt
      if (cached.outputType === "text" || cached.outputType === "structured") {
        record.outputType = cached.outputType
      }
      shared.onAgentUpdate?.(record)
      return cached.result
    }
    if (!hashMatches || cachedEmpty) {
      scope.firstMiss = Math.min(scope.firstMiss, callIndex)
    }

    // 真实执行才记起始时间戳（journal 回放上面已 return，不带此字段；TUI phase 耗时用）
    record.startedAt = agentStarted

    return shared.scheduler.run(async () => {
      const timeout = scriptOptions.timeoutMs !== undefined ? scriptOptions.timeoutMs : shared.agentTimeoutMs
      const retries = normalizeAgentRetries(scriptOptions.retries ?? shared.agentRetries ?? 0)
      const maxAttempts = retries + 1

      // worktree 隔离（P1-5）：确定性命名（runId-callIndex-label）保证 resume key 稳定；
      // 失败静默降级共享目录；结束（含超时/abort）在 finally 拆除；结果不自动合并（与 Pi 一致）
      let worktree: WorktreeInfo | undefined
      if (scriptOptions.isolation === "worktree") {
        worktree = await createWorktree(shared.cwd, `${shared.runId}-${callIndex}-${label}`)
        if (worktree.isolated) log(`agent "${label}" worktree 隔离：${worktree.branch} @ ${worktree.cwd}`)
        else log(`agent "${label}" 的 worktree 隔离不可用，降级共享目录（${worktree.reason}）`)
      }
      const runDirectory = worktree?.isolated ? worktree.cwd : undefined
      // 平台路由类注：目录 query 在真机上未生效（三次实验 session.directory 均落共享目录，
      // 服务端多套路由面静态追踪未定位到尊重该 query 的路径），改为 prompt 注入工作目录——
      // agent 用绝对路径/先 cd 完成隔离写；query 保留给未来版本。语义不变：worktree 生命周期照旧。
      const effectivePrompt = runDirectory
        ? `${prompt}\n\n[工作目录] 你在一个独立的 git worktree 中（分支 ${worktree!.branch}）。全部文件操作必须在以下目录内进行，用绝对路径或先 cd：\n${runDirectory}`
        : prompt

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          throwIfAborted()
          // 每次 attempt 一个独立 controller：超时只取消本次，run 级 abort 取消所有
          const attemptController = new AbortController()
          const onRunAbort = () => attemptController.abort()
          shared.signal?.addEventListener("abort", onRunAbort)
          // 本次执行的标识与计时（FR-1：nodeId=runId:callIndex，executionId 追加 attempt 维度）
          const attemptStarted = Date.now()
          const executionId = `${deltaKey}:${attempt}`
          // usage 基线：record 上的拆分计数跨 attempt 累计，差值即本次执行用量
          const usageBaseIn = record.inputTokens ?? 0
          const usageBaseOut = record.outputTokens ?? 0
          const attemptUsage = () => ({
            inputTokens: (record.inputTokens ?? 0) - usageBaseIn,
            outputTokens: (record.outputTokens ?? 0) - usageBaseOut,
          })
          /** 失败/中止 attempt 的执行记录发射（FR-7）；成功路径不发，读端以 journal entry 本体为最新执行。
           *  同时把 executionId/attempt 回填 record：失败节点也要能在 Node Detail 显示尝试次数 */
          const emitExecution = (status: "failed" | "aborted", error?: string) => {
            record.executionId = executionId
            record.attempt = attempt
            shared.onAgentExecution?.({
              key: deltaKey,
              execution: {
                executionId,
                attempt,
                status,
                label,
                sessionId: record.sessionId,
                error,
                startedAt: attemptStarted,
                durationMs: Date.now() - attemptStarted,
                usage: attemptUsage(),
              },
            })
          }
          try {
            const runOptions: AgentRunOptions = {
              label,
              phase: displayPhase,
              agentType: scriptOptions.agentType,
              model: modelSpec,
              schema: scriptOptions.schema,
              directory: runDirectory,
              signal: attemptController.signal,
              onUsage: (usage: AgentUsage) => {
                record.tokens = (record.tokens ?? 0) + (usage.total ?? 0)
                record.cost = (record.cost ?? 0) + (usage.cost ?? 0)
                record.inputTokens = (record.inputTokens ?? 0) + (usage.input ?? 0)
                record.outputTokens = (record.outputTokens ?? 0) + (usage.output ?? 0)
              },
              onSessionCreated: (sessionId) => {
                record.sessionId = sessionId
                shared.onAgentUpdate?.(record)
              },
            }
            const execution = await withTimeout(shared.agentRunner.run(effectivePrompt, runOptions), timeout, label, () =>
              attemptController.abort(),
            )
            const value = execution.value
            record.status = "ok"
            record.durationMs = Date.now() - agentStarted
            record.model = modelSpec
            // Node Inspector 元数据（FR-1/FR-3）：sessionId 以本次执行结果为准
            record.executionId = executionId
            record.attempt = attempt
            record.sessionId = execution.sessionId
            record.outputType = execution.type
            record.outputPreview = buildOutputPreview(execution.value)
            shared.onAgentUpdate?.(record)
            // 成功且非空结果写入 journal 回放缓存；失败/null/空文本不进（与 Pi 一致）。
            // 载荷为整条 JournalEntry（展示元数据随扩展字段直通落盘）；prompt 用原始脚本入参（非 worktree 拼接版）
            if (!isEmptyTextResult(value, scriptOptions.schema)) {
              shared.onAgentJournal?.({
                key: deltaKey,
                hash: callHash,
                result: value,
                model: modelSpec,
                label,
                phase: displayPhase,
                agentType: scriptOptions.agentType,
                sessionId: execution.sessionId,
                prompt: truncatePromptForJournal(prompt),
                outputType: execution.type,
                executionId,
                attempt,
                startedAt: attemptStarted,
                durationMs: Date.now() - attemptStarted,
                usage: attemptUsage(),
              })
            }
            return value
          } catch (error) {
            if (isAborted()) {
              record.status = "aborted"
              record.durationMs = Date.now() - agentStarted
              emitExecution("aborted")
              shared.onAgentUpdate?.(record)
              throw wrapError(error)
            }
            const workflowError = wrapError(error)
            if (!workflowError.recoverable) {
              record.status = "failed"
              record.error = workflowError.message
              record.durationMs = Date.now() - agentStarted
              emitExecution("failed", workflowError.message)
              shared.onAgentUpdate?.(record)
              throw workflowError
            }
            if (attempt >= maxAttempts) {
              record.status = "failed"
              record.error = workflowError.message
              record.durationMs = Date.now() - agentStarted
              emitExecution("failed", workflowError.message)
              shared.onAgentUpdate?.(record)
              log(`agent "${label}" ${maxAttempts} 次尝试后失败: ${workflowError.code} ${workflowError.message}`)
              return null
            }
            emitExecution("failed", workflowError.message)
            log(`agent "${label}" 第 ${attempt} 次尝试失败，重试: ${workflowError.message}`)
          } finally {
            shared.signal?.removeEventListener("abort", onRunAbort)
          }
        }
        return null
      } finally {
        // 无论成功/失败/超时/abort，都拆除 worktree（与 Pi 一致）
        if (worktree?.isolated) await removeWorktree(worktree)
      }
    })
  }

  // ── workflow() 原语：Native Composition（v0.8） ──

  /** 规范化 workflow 脚本路径：resolve + realpath + Windows 大小写归一（自环检查用） */
  const canonicalWorkflowPath = (p: string): string => {
    let resolved = path.resolve(shared.cwd, p)
    try {
      if (fs.existsSync(resolved)) resolved = fs.realpathSync.native(resolved)
    } catch {
      // realpath 失败（文件不存在等）保留 resolve 结果，由后续读盘报精确错误
    }
    if (process.platform === "win32") resolved = resolved.toLowerCase()
    return resolved
  }

  /** 显式路径判定（v0.10）：./ ../ 与绝对路径为路径语义；其余（含斜杠名如 ui/main-menu）查 registry */
  const isExplicitPath = (ref: string): boolean =>
    ref.startsWith("./") || ref.startsWith("../") || path.isAbsolute(ref)

  /** 名字解析：registry 缓存懒加载（首查扫描），未命中报错并列已知名 */
  const resolveByName = (workflowId: string): string => {
    if (!shared.registryCache) {
      shared.registryCache = new Map(
        Array.from(loadRegistry(shared.cwd).entries()).map(([id, wf]) => [id, wf.filePath]),
      )
    }
    const found = shared.registryCache.get(workflowId)
    if (!found) {
      const known = Array.from(shared.registryCache.keys()).join(", ") || "（目录为空或不存在）"
      throw new WorkflowError(
        `WORKFLOW_NOT_FOUND：workflow() 未找到名为 "${workflowId}" 的子流程（目录 ${workflowsDir(shared.cwd)}，已知 id：${known}；脚本需含 export const meta = { id 或 name }）`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }
    return found
  }

  const workflow = async (ref: WorkflowRef, childArgs?: unknown): Promise<unknown> => {
    throwIfAborted()
    // [关键] 同步阶段首行领号：childSeq++ 必须发生在任何 await 之前——
    // parallel 下 resolve/parse 异步化会让 wfN 按完成顺序分配，journal 不稳定；
    // 失败的 invocation 也消耗编号不回收（调用位置决定身份）
    const childIndex = scope.childSeq++
    const keySegment = `wf${childIndex}`

    // ref 解析（对象形式取 scriptPath/label，字符串形式为路径）
    let scriptPath: string
    let label: string | undefined
    if (typeof ref === "string") {
      scriptPath = ref
    } else if (ref && typeof ref === "object" && typeof ref.scriptPath === "string") {
      scriptPath = ref.scriptPath
      label = ref.label
    } else {
      throw new WorkflowError(
        "workflow() 需要 scriptPath 字符串或 { scriptPath, label? } 对象",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }

    const canonical = isExplicitPath(scriptPath) ? canonicalWorkflowPath(scriptPath) : canonicalWorkflowPath(resolveByName(scriptPath))
    // 自环检查（先于深度检查："child 调祖先"报更具体的自环错而非深度错）：沿 scope 链比对（顺带为 P2 多层备好环检测）
    for (let s: WorkflowScope | undefined = scope; s; s = s.parent) {
      if (s.canonicalPath && s.canonicalPath === canonical) {
        throw new WorkflowError(
          `workflow 不能调用自身或祖先：${canonical}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        )
      }
    }

    // 深度限制（P1 仅一层 child）
    if (scope.depth >= MAX_WORKFLOW_DEPTH) {
      throw new WorkflowError(
        `workflow() 嵌套深度超限（当前最多 ${MAX_WORKFLOW_DEPTH} 层子 workflow）`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }

    let childScript: string
    try {
      childScript = fs.readFileSync(canonical, "utf-8")
    } catch {
      throw new WorkflowError(
        `workflow() 子脚本不存在或不可读：${scriptPath}（解析为 ${canonical}）`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }

    // structuredClone 调用边界：child args 与 parent 传入对象无引用共享（VM 内 mutation 不外溢）
    let clonedArgs: unknown
    try {
      clonedArgs = structuredClone(childArgs ?? {})
    } catch {
      throw new WorkflowError(
        "workflow() 的 args 必须是 structured-clone-compatible 数据（object/array/string/number/boolean/null）",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }

    const childMeta = parseWorkflowScript(childScript).meta
    const childLabel = label?.trim() || childMeta.name
    const childScope: WorkflowScope = {
      name: childMeta.name,
      label: childLabel,
      scriptPath,
      canonicalPath: canonical,
      depth: scope.depth + 1,
      phasePrefix: `▸ ${childLabel} / `,
      callSeq: 0,
      childSeq: 0,
      keySegment,
      firstMiss: Number.POSITIVE_INFINITY,
      parent: scope,
      // 路径身份链：继承父链 + 自身（v0.9 Observability）
      pathLabels: [...(scope.pathLabels ?? []), childLabel],
      pathKeys: [...(scope.pathKeys ?? []), keySegment],
    }
    log(`workflow("${childLabel}") 启动（key=${keySegment}，script=${canonical}）`)
    try {
      const child = await executeWorkflow(childScript, clonedArgs, shared, childScope)
      log(`workflow("${childLabel}") 完成`)
      // 返回值同样克隆：child 结果不与 VM 内引用共享
      return structuredClone(child.result)
    } catch (error) {
      log(`workflow("${childLabel}") 失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
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

  // ── 质量与控制 DSL（P1-4，纯构建在 agent()/parallel() 之上，callSeq 稳定、resume 安全） ──

  const VERIFY_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  }

  const JUDGE_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  }

  const normalizeQualityFanout = (value: unknown, fallback: number, optionName: string): number => {
    const count = value === undefined ? fallback : value
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
      throw new TypeError(`${optionName} 必须是大于等于 1 的整数`)
    }
    return count
  }

  /** 对抗式评审：多个 reviewer 尝试反驳 item，投票达阈值判真 */
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ): Promise<unknown> => {
    throwIfAborted()
    const reviewerSlots = normalizeQualityFanout(opts.reviewers, 2, "verify() reviewers")
    const threshold = opts.threshold ?? 0.5
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : []
    const claim = typeof item === "string" ? item : JSON.stringify(item)
    const votes = (
      await parallel(
        Array.from({ length: reviewerSlots }, (_v, i) => () =>
          agent(
            `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
            { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
          )),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>
    const realCount = votes.filter((v) => v?.real).length
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    }
  }

  /** 评审团：多个 judge 按指标给每个候选打分，返回最高均分 */
  const judgePanel = async (
    attempts: unknown[],
    opts: { judges?: number; rubric?: string } = {},
  ): Promise<unknown> => {
    throwIfAborted()
    const judgeSlots = normalizeQualityFanout(opts.judges, 3, "judgePanel() judges")
    const candidates: Array<{ attempt: unknown; index: number }> = Array.isArray(attempts)
      ? attempts.map((attempt, index) => ({ attempt, index })).filter((c) => c.attempt != null)
      : []
    if (!candidates.length) throw new TypeError("judgePanel() 需要非空候选数组")
    const rubric = opts.rubric ?? "overall quality and correctness"
    const scored = (
      await parallel(
        candidates.map(({ attempt: att, index }) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att)
          const js = (
            await parallel(
              Array.from({ length: judgeSlots }, (_v, j) => () =>
                agent(`Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`, {
                  label: `judge ${index + 1}.${j + 1}`,
                  schema: JUDGE_SCHEMA,
                })),
            )
          ).filter(Boolean) as Array<{ score?: number }>
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0
          return { index, attempt: att, score, judgments: js }
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>
    // 最高均分；同分稳定取输入顺序靠前者（与 Pi 一致）
    let best = scored[0]
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s
    return best
  }

  /** 有界重试糖：直到 until 通过或耗尽，返回最后一次结果（不抛错） */
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ): Promise<unknown> => {
    const attempts = Math.max(1, opts.attempts ?? 3)
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i)
      const accepted = !opts.until || opts.until(last)
      if (accepted) return last
    }
    return last
  }

  /** 人工确认点（P1-4，Pi checkpoint 的确认型子集）：确定性哈希 + journal 回放，不花 token */
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}): Promise<unknown> => {
    throwIfAborted()
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) 需要 prompt 字符串")
    // 哈希身份：promptText + default + headless（与结果相关的全部选项）
    const callIndex = scope.callSeq++
    const journalKey = scopedKey(shared, scope, callIndex)
    const callHash = createHash("sha256")
      .update(JSON.stringify({ promptText, default: checkpointOptions.default ?? null, headless: checkpointOptions.headless ?? null }))
      .digest("hex")
    const cached = shared.resumeJournal?.get(journalKey)
    if (cached != null && cached.hash === callHash && callIndex < scope.firstMiss) {
      shared.agentCount++
      return cached.result
    }
    if (cached == null || cached.hash !== callHash) {
      scope.firstMiss = Math.min(scope.firstMiss, callIndex)
    }
    shared.agentCount++

    let reply: unknown
    if (shared.confirm) {
      reply = await shared.confirm(promptText)
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint 需要人工确认但无可用通道（headless）："${promptText}"`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      )
    } else {
      reply = checkpointOptions.default ?? true
    }
    throwIfAborted()
    log(`checkpoint："${promptText}" -> ${JSON.stringify(reply)}`)
    shared.onAgentJournal?.({ key: journalKey, hash: callHash, result: reply })
    return reply
  }

  // 脚本内动态调节并发上限（需求文档：动态并发控制 方案 A）：
  // 非法值报错；超上限钳制并记日志；变更经 SharedScheduler 同步 limiter（结构上不可能失同步）
  const setConcurrency = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
      throw new WorkflowError(
        `setConcurrency 需要正整数，收到 ${String(value)}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      )
    }
    shared.scheduler.setConcurrency(value)
  }

  // globals：每次 invocation 独立构造（args 闭包绑定当前 scope；parallel child 间绝不共享）
  const globals: Record<string, unknown> = {
    agent,
    workflow,
    parallel,
    pipeline,
    phase,
    log,
    args,
    setConcurrency,
    verify,
    judgePanel,
    retry,
    checkpoint,
    console: consoleShim,
  }

  try {
    const result = await runScriptInVm(body, scope.label, globals)
    wfRecord.endedAt = Date.now()
    wfRecord.durationMs = wfRecord.endedAt - wfRecord.startedAt
    wfRecord.status = "ok"
    return { meta, result }
  } catch (error) {
    shared.aborted = true
    wfRecord.endedAt = Date.now()
    wfRecord.durationMs = wfRecord.endedAt - wfRecord.startedAt
    wfRecord.status = isAborted() ? "aborted" : "failed"
    wfRecord.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

/** 带超时的 Promise 竞争；onTimeout 在拒绝生效前触发，用于取消底层工作 */
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
 * agent 调用的稳定身份哈希（P1-1）。
 * 身份面 = prompt / model spec / tier / phase（含 scope 前缀）/ agentType / schema，sha256 后十六进制。
 * 注意：model/tier 只取脚本声明的 spec（与 Pi 一致，resolveTier 解析结果不进哈希，换 tier 配置不破缓存）；
 * phase 含前缀 —— child 与 root 的同 prompt agent 天然不同 key，不混淆缓存。
 */
function hashAgentCall(prompt: string, options: ScriptAgentOptions, phase: string | undefined): string {
  const identity = JSON.stringify({
    prompt,
    model: options.model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    schema: options.schema ?? null,
    isolation: options.isolation ?? null,
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
