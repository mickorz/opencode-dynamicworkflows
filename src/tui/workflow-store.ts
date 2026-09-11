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
  status: WorkflowNodeStatus
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
}

/** sidebar 展示行：phase 标题行或 agent 节点行 */
export type SidebarRow = { kind: "phase"; title: string } | { kind: "node"; node: WorkflowNode }

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
      status: n.status,
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
 * 组装 sidebar 展示行：按执行顺序遍历节点，phase 变化时插入标题行
 * （连续同 phase 的节点自然成组；无 phase 的节点直接平铺，不产生标题行）
 */
export function buildSidebarRows(progress: WorkflowProgress): SidebarRow[] {
  const rows: SidebarRow[] = []
  let currentPhase: string | undefined
  for (const node of progress.nodes) {
    if (node.phase && node.phase !== currentPhase) {
      rows.push({ kind: "phase", title: node.phase })
      currentPhase = node.phase
    }
    rows.push({ kind: "node", node })
  }
  return rows
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
 */
export type MultiRunRow =
  | { kind: "run"; runId: string; title: string; status: WorkflowProgressStatus }
  | { kind: "phase"; title: string; runId: string }
  | { kind: "node"; node: WorkflowNode; runId: string }

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

/** viewKey：稳定字符串摘要，不变则不写 signal 避免无谓重渲（omo viewKey 差分） */
export function progressViewKey(progress: WorkflowProgress | null): string {
  if (!progress) return "none"
  return `${progress.runId}|${progress.status}|${progress.total}|${progress.completed}|${progress.running}|${progress.failed}`
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
