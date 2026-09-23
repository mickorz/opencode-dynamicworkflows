/**
 * TUI 侧 workflow 状态提取（F-20 / TUI 增强 MVP-1 前台通道的读取端）
 *
 * 数据来源：workflow tool 经 ToolContext.metadata 写进 ToolPart.state.metadata 的
 * 进度快照（形状见 src/tools/workflow-progress.ts，两侧共用同一契约）。
 *
 * 本文件是纯 TypeScript（无 solid-js 依赖），可被 node:test 直接测试；
 * solid 渲染集中在 plugin.tsx 单文件（需求文档 9.3 单实例约束）。
 */

export type WorkflowProgressStatus = "running" | "completed" | "aborted" | "failed"
export type WorkflowNodeStatus = "running" | "ok" | "failed" | "aborted"

/** 与 server 侧 AgentRecord 对应的节点（结构性宽松校验后的安全形状） */
export interface WorkflowNode {
  id: string
  label: string
  phase?: string
  /** 展示身份（scope 链 label 数组；root 的 agent 无此字段，旧快照兼容） */
  workflowPath?: string[]
  status: WorkflowNodeStatus
  /** 该 agent 开始执行的绝对时间戳（毫秒）；回放与老快照无此字段 */
  startedAt?: number
  durationMs?: number
  sessionId?: string
  tokens?: number
  cost?: number
  error?: string
  replayed?: boolean
  model?: string
  // ---- Node Inspector 扩展（全部可选；老快照/metadata 无这些字段，解析为 undefined）----
  /** 最新一次真实执行的标识（runId:callIndex:attempt） */
  executionId?: string
  /** 最后一次尝试的序号（1 起算） */
  attempt?: number
  outputType?: "text" | "structured"
  /** 结果 2KB 截断预览（已脱敏）；完整内容在 journal，Node Detail 兜底用 */
  outputPreview?: string
  inputTokens?: number
  outputTokens?: number
  /** 组合链（cmpN；在 sequence/fallback/race 内执行时携带，P2-3 展示用） */
  compositePath?: string[]
}

export interface WorkflowProgress {
  runId: string
  name: string
  status: WorkflowProgressStatus
  phases: string[]
  nodes: WorkflowNode[]
  running: number
  completed: number
  failed: number
  total: number
  /** 快照写入时刻（毫秒；快照通道有，metadata 通道无）。心跳 3 秒更新它
   *  并经 progressViewKey 触发重渲染，是 running 期耗时递增的刷新源 */
  time?: number
  /** 触发本 run 的会话（B2 层级显示）：顶层 run 等于当前会话，嵌套 run 为某节点的子会话；缺省视为顶层 */
  parentSessionId?: string
  /** 组合节点执行记录（P2-3 可选；旧快照无此字段） */
  composites?: CompositeInfo[]
}

/** 组合节点记录（server CompositeRecord 的 TUI 宽松拷贝；禁止 import server 模块） */
export interface CompositeInfo {
  id: string
  kind: "sequence" | "fallback" | "race"
  label: string
  status: "running" | "ok" | "failed" | "aborted"
  compositePath: string[]
}

/** sidebar 展示行：workflow 分组行（子流程一级）/ composite 组合行（P2-3）/ phase 标题行 / agent 节点行 */
export type SidebarRow =
  | { kind: "workflow"; title: string }
  | { kind: "composite"; title: string }
  | { kind: "phase"; title: string }
  | { kind: "node"; node: WorkflowNode }

/** composites 数组宽松解析（P2-3）：坏形状条目静默跳过；返回空数组时调用方不写字段 */
export function parseCompositeInfos(raw: unknown[]): CompositeInfo[] {
  const out: CompositeInfo[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const c = item as Record<string, unknown>
    if (typeof c.id !== "string" || !c.id) continue
    if (c.kind !== "sequence" && c.kind !== "fallback" && c.kind !== "race") continue
    if (!Array.isArray(c.compositePath)) continue
    out.push({
      id: c.id,
      kind: c.kind,
      label: typeof c.label === "string" && c.label ? c.label : c.id,
      status: c.status === "running" || c.status === "ok" || c.status === "failed" || c.status === "aborted" ? c.status : "running",
      compositePath: c.compositePath.filter((x): x is string => typeof x === "string"),
    })
  }
  return out
}

/** ToolPart.metadata 是 any（无类型约束），形状校验失败一律返回 null 防崩（旧结构/异构数据） */
export function parseWorkflowMetadata(raw: unknown): WorkflowProgress | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.runId !== "string" || !rec.runId) return null
  if (!Array.isArray(rec.agents)) return null

  const nodes: WorkflowNode[] = []
  for (const item of rec.agents) {
    if (!item || typeof item !== "object") continue
    const n = item as Record<string, unknown>
    if (typeof n.id !== "string" || typeof n.label !== "string" || typeof n.status !== "string") continue
    if (!isNodeStatus(n.status)) continue
    nodes.push({
      id: n.id,
      label: n.label,
      phase: typeof n.phase === "string" ? n.phase : undefined,
      workflowPath: Array.isArray(n.workflowPath)
        ? n.workflowPath.filter((p): p is string => typeof p === "string")
        : undefined,
      status: n.status,
      startedAt: typeof n.startedAt === "number" ? n.startedAt : undefined,
      durationMs: typeof n.durationMs === "number" ? n.durationMs : undefined,
      sessionId: typeof n.sessionId === "string" ? n.sessionId : undefined,
      tokens: typeof n.tokens === "number" ? n.tokens : undefined,
      cost: typeof n.cost === "number" ? n.cost : undefined,
      error: typeof n.error === "string" ? n.error : undefined,
      replayed: n.replayed === true,
      model: typeof n.model === "string" ? n.model : undefined,
      executionId: typeof n.executionId === "string" ? n.executionId : undefined,
      attempt: typeof n.attempt === "number" ? n.attempt : undefined,
      outputType: n.outputType === "text" || n.outputType === "structured" ? n.outputType : undefined,
      outputPreview: typeof n.outputPreview === "string" ? n.outputPreview : undefined,
      inputTokens: typeof n.inputTokens === "number" ? n.inputTokens : undefined,
      outputTokens: typeof n.outputTokens === "number" ? n.outputTokens : undefined,
      compositePath: Array.isArray(n.compositePath)
        ? n.compositePath.filter((p): p is string => typeof p === "string")
        : undefined,
    })
  }
  if (nodes.length === 0) return null

  const phases: string[] = []
  for (const node of nodes) {
    if (node.phase && !phases.includes(node.phase)) phases.push(node.phase)
  }

  const status: WorkflowProgressStatus = isProgressStatus(rec.status) ? rec.status : "running"
  return {
    runId: rec.runId,
    name: typeof rec.name === "string" && rec.name ? rec.name : "workflow",
    status,
    phases,
    nodes,
    ...(Array.isArray(rec.composites) ? { composites: parseCompositeInfos(rec.composites) } : {}),
    running: nodes.filter((n) => n.status === "running").length,
    completed: nodes.filter((n) => n.status === "ok").length,
    failed: nodes.filter((n) => n.status === "failed").length,
    total: nodes.length,
  }
}

/** 消息的最小结构形状（避免 TUI 侧直接依赖 SDK 类型定义；state 用 unknown 兼容各状态变体） */
export interface ToolPartLike {
  type: string
  tool?: string
  state?: unknown
}

/**
 * 从会话消息里找最近一次 workflow tool 调用的 metadata（从后往前扫描）。
 * 注意：TUI sync store 里 message 与 part 分开存（store.message 按 sessionID、
 * store.part 按 messageID），message 对象不带内联 parts——必须经 getParts(messageID)
 * 取每个消息的 part 列表（TuiState.part 就是这个 API）。
 */
export function findWorkflowMetadata(
  messages: ReadonlyArray<{ id?: unknown }>,
  getParts: (messageID: string) => ReadonlyArray<ToolPartLike> | undefined,
): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageID = messages[i].id
    if (typeof messageID !== "string") continue
    const parts = getParts(messageID) ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      const state = part.state as { metadata?: unknown } | undefined
      if (part.type === "tool" && part.tool === "workflow") return state?.metadata
    }
  }
  return undefined
}

/**
 * 组装 sidebar 展示行（两级分组 + 全链，分支 A）：按执行顺序遍历节点，
 * 子流程分组键用 workflowPath 全链 join（深层唯一不碰撞），行标题显示完整链（a / b）；
 * root 节点（无 workflowPath）直接按 phase 平铺（旧行为兼容）。
 * 交错场景（并行 child 网络序）同一 workflow 行可能重复出现——与 phase 行同为时间线式语义。
 */
export function buildSidebarRows(progress: WorkflowProgress): SidebarRow[] {
  const rows: SidebarRow[] = []
  const compositeLabels = new Map<string, string>()
  for (const c of progress.composites ?? []) {
    if (c && typeof c.id === "string" && typeof c.label === "string") compositeLabels.set(c.id, c.label)
  }
  let currentWorkflow: string | undefined
  let currentComposite: string | undefined
  let currentPhase: string | undefined
  for (const node of progress.nodes) {
    const wfGroup = node.workflowPath?.length ? node.workflowPath.join("\u0000") : undefined
    if (wfGroup && wfGroup !== currentWorkflow) {
      rows.push({ kind: "workflow", title: node.workflowPath!.join(" / ") })
      currentWorkflow = wfGroup
      currentComposite = undefined // 换组后组合链重新起头
      currentPhase = undefined // 换组后 phase 重新起头
    }
    // 组合链分组（P2-3）：链变化时为新进入的段发 composite 行；退出组合（undefined）不发
    const cmpChain = node.compositePath?.length ? node.compositePath.join("\u0000") : undefined
    if (cmpChain !== currentComposite) {
      const prev = currentComposite ? currentComposite.split("\u0000") : []
      for (const segment of node.compositePath ?? []) {
        if (!prev.includes(segment)) {
          const depth = (node.compositePath ?? []).indexOf(segment)
          rows.push({
            kind: "composite",
            title: `${"  ".repeat(Math.max(0, depth))}${compositeLabels.get(segment) ?? segment}`,
          })
        }
      }
      currentComposite = cmpChain
      currentPhase = undefined // 换组合后 phase 重新起头
    }
    if (node.phase && node.phase !== currentPhase) {
      rows.push({ kind: "phase", title: node.phase })
      currentPhase = node.phase
    }
    rows.push({ kind: "node", node })
  }
  return rows
}

/** 节点展示行文本：label · 耗时 · token · 回放标记。running 且有 startedAt 时显示整数秒实时耗时
 *  （随轮询重渲染递增，约 3 秒一跳），完成态保持一位小数格式 */
export function nodeLine(node: WorkflowNode): string {
  const duration =
    node.status === "running" && node.startedAt !== undefined
      ? formatElapsed(Math.max(0, Date.now() - node.startedAt))
      : formatDuration(node.durationMs)
  const tokens = formatTokens(node.tokens)
  const replayed = node.replayed ? " ·缓存" : ""
  const durationPart = duration ? ` ·${duration}` : ""
  const tokensPart = tokens ? ` ·${tokens} tok` : ""
  return `${node.label}${durationPart}${tokensPart}${replayed}`
}

/** phase 耗时（毫秒）：start = 组内最早 startedAt；存在 running 节点时 now - start 递增，
 *  否则 max(startedAt+durationMs) - start 定格（并行重叠不重复计费，墙钟口径）。
 *  全组无 startedAt（journal 回放或老快照）返回 undefined，渲染层不显示该段 */
export function phaseElapsedMs(nodes: ReadonlyArray<WorkflowNode>, now: number): number | undefined {
  let start: number | undefined
  let end = 0
  let running = false
  for (const n of nodes) {
    if (typeof n.startedAt !== "number") continue
    if (start === undefined || n.startedAt < start) start = n.startedAt
    const nodeEnd = n.startedAt + (n.durationMs ?? 0)
    if (nodeEnd > end) end = nodeEnd
    if (n.status === "running") running = true
  }
  if (start === undefined) return undefined
  return running ? Math.max(0, now - start) : end - start
}

/** 整数秒格式化（phase 行与 running 节点实时耗时；区别于完成态节点的一位小数）：23s / 1m05s */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "0s"
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${(total % 60).toString().padStart(2, "0")}s`
}

/** 单树标题行：名称 进度计数 运行中后缀 token 合计 runId（sidebar 与全屏路由共用；runId 供 resume 续跑复制） */
export function headerLine(progress: WorkflowProgress): string {
  const suffix =
    progress.status === "running" && progress.running > 0 ? ` | ${progress.running} running` : ""
  const tokens = sumTokens(progress)
  const tokensPart = tokens > 0 ? ` | ${formatTokens(tokens)} tok` : ""
  return `${progress.name} (${progress.completed}/${progress.total}${suffix})${tokensPart} | ${progress.runId}`
}

/**
 * 多树合并行（全屏路由 /workflow 用）：每棵树前插入 run 标题行，节点行携带 runId。
 * 不同 run 的节点 id 可能重复，选中态用 runId 节点id 复合键保证跨树唯一。
 * depth 为 B2 层级显示的缩进层级（顶层 0，嵌套子 run 递增）。
 */
export type MultiRunRow =
  | { kind: "run"; runId: string; title: string; status: WorkflowProgressStatus; depth?: number }
  | { kind: "workflow"; title: string; runId: string; depth?: number }
  | { kind: "phase"; title: string; runId: string; depth?: number }
  | { kind: "node"; node: WorkflowNode; runId: string; depth?: number }

/**
 * 按血统拆分顶层与嵌套子 run（B2 层级显示）：
 *  顶层 = parentSessionId 缺省、等于当前会话、或指向不可见节点（孤儿提升，不隐藏数据）
 *  子 run 挂在触发节点名下：node.sessionId === run.parentSessionId
 * 传入列表需已按创建时间降序（pickAllProgresses 保证），子 run 同一节点下自然保持该序。
 * 会话父子链是无环的（node 会话是 run 期间新建的子会话），递归必然终止。
 */
export function splitRunsByParent(
  progresses: ReadonlyArray<WorkflowProgress>,
  sessionId: string,
): { tops: WorkflowProgress[]; childrenOf: (parentSessionId: string) => WorkflowProgress[] } {
  const children = new Map<string, WorkflowProgress[]>()
  const nodeSessions = new Set<string>()
  for (const progress of progresses) {
    for (const node of progress.nodes) {
      if (node.sessionId) nodeSessions.add(node.sessionId)
    }
    if (progress.parentSessionId) {
      const list = children.get(progress.parentSessionId) ?? []
      list.push(progress)
      children.set(progress.parentSessionId, list)
    }
  }
  const tops = progresses.filter(
    (p) => !p.parentSessionId || p.parentSessionId === sessionId || !nodeSessions.has(p.parentSessionId),
  )
  const childrenOf = (parentSessionId: string) => children.get(parentSessionId) ?? []
  return { tops, childrenOf }
}

/**
 * 层级多树行（B2）：顶层 run 各成块，嵌套子 run 的行插在其触发节点之后并带 depth 缩进。
 * 行序即展示序，与 j/k 键盘导航、scrollChildIntoView 滚动跟随共用。
 */
export function buildNestedRunRows(
  progresses: ReadonlyArray<WorkflowProgress>,
  sessionId: string,
): MultiRunRow[] {
  const { tops, childrenOf } = splitRunsByParent(progresses, sessionId)
  const rows: MultiRunRow[] = []
  const emitRun = (progress: WorkflowProgress, depth: number) => {
    // depth 仅在大于 0 时写入：旧形状等价（退化场景与 buildMultiRunRows 逐字段一致）
    const withDepth = <T extends object>(row: T): T => (depth ? { ...row, depth } : row)
    rows.push(withDepth({ kind: "run", runId: progress.runId, title: headerLine(progress), status: progress.status }))
    let currentPhase: string | undefined
    for (const node of progress.nodes) {
      if (node.phase && node.phase !== currentPhase) {
        rows.push(withDepth({ kind: "phase", title: node.phase, runId: progress.runId }))
        currentPhase = node.phase
      }
      rows.push(withDepth({ kind: "node", node, runId: progress.runId }))
      if (node.sessionId) {
        for (const child of childrenOf(node.sessionId)) emitRun(child, depth + 1)
      }
    }
  }
  for (const top of tops) emitRun(top, 0)
  return rows
}

export function buildMultiRunRows(progresses: ReadonlyArray<WorkflowProgress>): MultiRunRow[] {
  const rows: MultiRunRow[] = []
  for (const progress of progresses) {
    rows.push({ kind: "run", runId: progress.runId, title: headerLine(progress), status: progress.status })
    let currentPhase: string | undefined
    for (const node of progress.nodes) {
      if (node.phase && node.phase !== currentPhase) {
        rows.push({ kind: "phase", title: node.phase, runId: progress.runId })
        currentPhase = node.phase
      }
      rows.push({ kind: "node", node, runId: progress.runId })
    }
  }
  return rows
}

/** 选中复合键：runId 节点id，跨树唯一 */
export function selectionKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

/** 多树可选中键列表（保持展示顺序，供 moveSelection 回绕导航） */
export function selectableNodeKeys(rows: ReadonlyArray<MultiRunRow>): string[] {
  return rows.filter((row) => row.kind === "node").map((row) => selectionKey(row.runId, row.node.id))
}

/** 按选中键在多树中找节点（含所属 runId，Node Detail 导航需要）；找不到返回 undefined */
export function findSelectedRunNode(
  progresses: ReadonlyArray<WorkflowProgress>,
  key: string | null,
): { runId: string; node: WorkflowNode } | undefined {
  if (!key) return undefined
  for (const progress of progresses) {
    for (const node of progress.nodes) {
      if (selectionKey(progress.runId, node.id) === key) return { runId: progress.runId, node }
    }
  }
  return undefined
}

/** 按选中键在多树中找节点；找不到返回 undefined */
export function findSelectedNode(
  progresses: ReadonlyArray<WorkflowProgress>,
  key: string | null,
): WorkflowNode | undefined {
  return findSelectedRunNode(progresses, key)?.node
}

/**
 * 可选中导航目标：节点行中带 sessionId 的（可进子会话）优先，无 sessionId 的也允许选中高亮但不可进入
 * 返回可选中节点 id 列表（保持展示顺序）
 */
/** 上下移动选中：delta +1 下移 与 -1 上移，越界回绕；空列表返回 undefined */
export function moveSelection(ids: ReadonlyArray<string>, currentId: string | null, delta: number): string | undefined {
  if (ids.length === 0) return undefined
  const index = currentId ? ids.indexOf(currentId) : -1
  if (index === -1) return delta >= 0 ? ids[0] : ids[ids.length - 1]
  const next = (index + delta + ids.length) % ids.length
  return ids[next]
}

/**
 * 多树 viewKey：全部树的稳定摘要拼接，不变则不写 signal 避免无谓重渲。
 * 单树内容（状态/计数）或树数量（新增/消失一个 run）变化都会改变 key。
 */
export function progressesViewKey(progresses: ReadonlyArray<WorkflowProgress>): string {
  if (progresses.length === 0) return "none"
  return progresses.map(progressViewKey).join(";")
}

/** viewKey：稳定字符串摘要，不变则不写 signal 避免无谓重渲（omo viewKey 差分）。
 *  混入快照 time：心跳 3 秒更新它，是 running 期耗时递增的重渲染触发源
 * （metadata 通道无 time 记 0；终态快照不再心跳，无额外重渲） */
export function progressViewKey(progress: WorkflowProgress | null): string {
  if (!progress) return "none"
  return `${progress.runId}|${progress.status}|${progress.total}|${progress.completed}|${progress.running}|${progress.failed}|${progress.time ?? 0}`
}

/** 耗时展示：843ms -> 0.8s / 12300ms -> 12.3s / 75000ms -> 1m15s */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ""
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`
}

/** token 展示：999 原样 / 9876 -> 9.9k / 1234567 -> 1.2m（千分位缩写，保留一位小数） */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return ""
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

/** 全部节点 token 合计（header 展示用） */
export function sumTokens(progress: WorkflowProgress): number {
  return progress.nodes.reduce((sum, node) => sum + (node.tokens ?? 0), 0)
}

function isNodeStatus(value: unknown): value is WorkflowNodeStatus {
  return value === "running" || value === "ok" || value === "failed" || value === "aborted"
}

function isProgressStatus(value: unknown): value is WorkflowProgressStatus {
  return value === "running" || value === "completed" || value === "aborted" || value === "failed"
}
