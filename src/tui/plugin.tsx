/** @jsxImportSource @opentui/solid */
/**
 * Dynamic Workflow TUI 插件实现（F-20 / MVP-1 前台通道的渲染端）
 *
 * 本文件是 src/tui/ 内唯一碰 solid-js 的文件（需求文档 9.3：
 * 跨文件分散 solid 用法会解析出不同 solid-js 实例，信号跨文件失效）。
 * 数据提取与行组装在 workflow-store.ts（纯 ts）。
 *
 * 骨架要点：
 *  - 折叠信号按 session 缓存于模块级 Map，重复渲染复用而非重建
 *  - sidebar_content 插槽 order:350（内置 LSP=300 之后、Todo=400 之前）
 */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Renderable } from "@opentui/core"
import { For, Show, createEffect, createSignal } from "solid-js"
import {
  buildMultiRunRows,
  buildSidebarRows,
  findSelectedRunNode,
  findWorkflowMetadata,
  formatDuration,
  formatTokens,
  headerLine,
  moveSelection,
  parseWorkflowMetadata,
  progressesViewKey,
  selectableNodeKeys,
  selectionKey,
  type WorkflowNode,
  type WorkflowProgress,
} from "./workflow-store.js"
import { listSessionSnapshots, pickAllProgresses } from "./run-snapshot-reader.js"
import { parseJournalFile, readJournalRaw, type JournalEntryView } from "./journal-reader.js"
import { resolveResultState, truncateUtf8ByBytes } from "./result-view.js"

const id = "opencode-dynamic-workflows"

/** workflow 全屏路由名（MVP-3）：api.route.register + 命令面板打开，Enter 进子会话的键盘导航在本路由内 */
const WORKFLOW_ROUTE = "opencode-dynamic-workflows.workflow"
/** 节点详情全屏路由名（Node Inspector）：展示该节点的 result（journal 内容 + 快照状态） */
const NODE_DETAIL_ROUTE = "opencode-dynamic-workflows.node"
/** 打开路由前的来源路由（Esc 返回用；module 级存单例，路由同时只有一个实例） */
let workflowReturnRoute: { name: string; params?: Record<string, unknown> } | null = null
/** 路由内选中节点（solid signal，跨副本闭环在本文件内） */
const [selectedNode, setSelectedNode] = createSignal<string | null>(null)
/** 路由键位层 disposer（焦点作用域，target 失焦即失效；离开路由时主动清，防悬挂） */
let disposeNavLayer: (() => void) | undefined

/** 节点状态图标与主题色调（几何符号非 emoji） */
function getNodeMeta(status: WorkflowNode["status"]): { icon: string; tone: "success" | "warning" | "error" | "muted" } {
  switch (status) {
    case "ok":
      return { icon: "●", tone: "success" }
    case "running":
      return { icon: "◐", tone: "warning" }
    case "failed":
      return { icon: "✖", tone: "error" }
    default:
      return { icon: "○", tone: "muted" }
  }
}

function toneColor(
  api: TuiPluginApi,
  tone: "success" | "warning" | "error" | "muted",
) {
  const theme = api.theme.current
  if (tone === "success") return theme.success
  if (tone === "warning") return theme.warning
  if (tone === "error") return theme.error
  return theme.textMuted
}

/** 折叠状态按 会话|run 复合键缓存（多树同显后每棵树独立折叠） */
const collapsedBySession = new Map<
  string,
  { collapsed: () => boolean; setCollapsed: (next: boolean | ((current: boolean) => boolean)) => void }
>()

/**
 * 进度信号按 session 缓存：宿主事件驱动重算 + 自己的 signal。
 * 不能在组件里直接读 api.state（宿主 solid store）——我们跑在自己的 solid-js 副本里，
 * 跨副本的依赖追踪不生效（Read 一次后永不更新，需求文档 9.3 的教训），
 * 因此只用 api.event.on 镜像数据到自己 signal。
 */
const progressBySession = new Map<string, () => WorkflowProgress[]>()

function computeProgresses(api: TuiPluginApi, sessionId: string): WorkflowProgress[] {
  // 多树合并：镜像快照逐个成树（失联的过滤），无快照时回退 tool 返回值 metadata（C 通道）
  let snapshots: ReturnType<typeof listSessionSnapshots> = []
  try {
    const directory = api.state.session.get(sessionId)?.directory ?? api.state.path.directory
    snapshots = listSessionSnapshots(directory, sessionId)
  } catch {
    // 读快照目录失败（权限等）：降级 C 通道
  }
  const metadataProgress = parseWorkflowMetadata(
    findWorkflowMetadata(api.state.session.messages(sessionId), (messageID) => api.state.part(messageID)),
  )
  return pickAllProgresses(snapshots, metadataProgress, Date.now())
}

/** 快照轮询间隔（omo 同款，agent 粒度变化频率下够用） */
const POLL_INTERVAL_MS = 1000

function getOrCreateProgress(
  api: TuiPluginApi,
  sessionId: string,
  onDispose: (fn: () => void) => void,
): () => WorkflowProgress[] {
  const cached = progressBySession.get(sessionId)
  if (cached) return cached

  const [progress, setProgress] = createSignal<WorkflowProgress[]>(computeProgresses(api, sessionId))
  // viewKey 差分：内容未变不写 signal，避免轮询驱动的无谓重渲
  let lastKey = progressesViewKey(progress())
  const applyProgress = (next: WorkflowProgress[]) => {
    const key = progressesViewKey(next)
    if (key === lastKey) return
    lastKey = key
    setProgress(next)
  }
  // 事件去抖：插件事件回调可能先于 sync store 落盘同一条事件，延迟一拍再读，
  // 同时把事件风暴合并为一次重算
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleRecompute = (eventSession: string | undefined) => {
    if (eventSession && eventSession !== sessionId) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      recomputeNow()
    }, 30)
  }
  const recomputeNow = () => {
    applyProgress(computeProgresses(api, sessionId))
  }

  const offs = [
    api.event.on("message.part.updated", (event) =>
      scheduleRecompute((event.properties as { part?: { sessionID?: string } }).part?.sessionID),
    ),
    api.event.on("message.part.removed", (event) => scheduleRecompute(event.properties.sessionID)),
    api.event.on("message.updated", (event) =>
      scheduleRecompute((event.properties as { info?: { sessionID?: string } }).info?.sessionID),
    ),
    api.event.on("message.removed", (event) => scheduleRecompute(event.properties.sessionID)),
  ]
  // 快照轮询驱动（B 通道主驱动，与事件驱动共用同一 signal）
  const poll = setInterval(recomputeNow, POLL_INTERVAL_MS)
  onDispose(() => {
    if (timer) clearTimeout(timer)
    clearInterval(poll)
    for (const off of offs) off()
    progressBySession.delete(sessionId)
  })
  progressBySession.set(sessionId, progress)
  return progress
}

function getOrCreateCollapsed(
  sessionId: string,
  runId: string,
  onDispose: (fn: () => void) => void,
): [() => boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const key = `${sessionId}|${runId}`
  const cached = collapsedBySession.get(key)
  if (cached) return [cached.collapsed, cached.setCollapsed]

  const [collapsed, setCollapsed] = createSignal(false)
  onDispose(() => {
    // 清理该会话下所有树的折叠信号（同会话多树共用一次 dispose）
    const prefix = `${sessionId}|`
    for (const k of Array.from(collapsedBySession.keys())) {
      if (k.startsWith(prefix)) collapsedBySession.delete(k)
    }
  })
  collapsedBySession.set(key, { collapsed, setCollapsed })
  return [collapsed, setCollapsed]
}

function nodeLine(node: WorkflowNode): string {
  const duration = formatDuration(node.durationMs)
  const tokens = formatTokens(node.tokens)
  const replayed = node.replayed ? " ·缓存" : ""
  const durationPart = duration ? ` ·${duration}` : ""
  const tokensPart = tokens ? ` ·${tokens} tok` : ""
  return `${node.label}${durationPart}${tokensPart}${replayed}`
}

/** 单棵 run 树：标题行折叠开关 + phase 分组节点列表（多树同显，每 run 独立一块） */
function RunTree(props: {
  api: TuiPluginApi
  session_id: string
  progress: WorkflowProgress
}) {
  const theme = () => props.api.theme.current
  const [collapsed, setCollapsed] = getOrCreateCollapsed(
    props.session_id,
    props.progress.runId,
    props.api.lifecycle.onDispose,
  )
  const rows = () => buildSidebarRows(props.progress)

  return (
    <box paddingBottom={1}>
      {/* 折叠开关只挂标题行：挂外层时节点点击导航后事件冒泡会把树折起来 */}
      <box onMouseDown={() => setCollapsed((current) => !current)}>
        <text fg={theme().text}>
          <b>{collapsed() ? "▶" : "▼"}</b> {headerLine(props.progress)}
        </text>
      </box>
      <Show when={!collapsed()}>
        <For each={rows()}>
          {(row) => {
            if (row.kind === "phase") {
              return (
                <box paddingLeft={1} paddingTop={1}>
                  <text fg={theme().textMuted}>{row.title}</text>
                </box>
              )
            }
            const meta = getNodeMeta(row.node.status)
            return (
              <box flexDirection="column">
                {/* Node Inspector：点击进节点详情视图（含 result 展示）；子会话经详情内 Open Session 进入。
                    running 态也可进入（sessionId 尚未回填时同样允许） */}
                <box
                  flexDirection="row"
                  onMouseDown={() =>
                    props.api.route.navigate(NODE_DETAIL_ROUTE, {
                      sessionID: props.session_id,
                      runId: props.progress.runId,
                      nodeId: row.node.id,
                      returnRoute: { name: "session", params: { sessionID: props.session_id } },
                    })
                  }
                >
                  <box width={2}>
                    <text fg={toneColor(props.api, meta.tone)}>{meta.icon} </text>
                  </box>
                  <box flexGrow={1}>
                    <text fg={toneColor(props.api, meta.tone)} wrapMode="word">
                      {nodeLine(row.node)}
                    </text>
                  </box>
                </box>
                <Show when={row.node.error}>
                  <box flexDirection="row" paddingLeft={2}>
                    <box width={2}>
                      <text fg={theme().textMuted}>↳ </text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={theme().textMuted} wrapMode="word">
                        {row.node.error}
                      </text>
                    </box>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const progresses = getOrCreateProgress(props.api, props.session_id, props.api.lifecycle.onDispose)

  return (
    <Show when={progresses().length > 0}>
      <box>
        <For each={progresses()}>
          {(progress) => <RunTree api={props.api} session_id={props.session_id} progress={progress} />}
        </For>
      </box>
    </Show>
  )
}

/** 全屏路由内节点行：比 sidebar 多展示 tokens 与进入标记 */
function routeNodeLine(node: WorkflowNode): string {
  const parts = [nodeLine(node)]
  parts.push("[Enter 详情]")
  return parts.join(" · ")
}

function navigateBack(api: TuiPluginApi): void {
  disposeNavLayer?.()
  disposeNavLayer = undefined
  const back = workflowReturnRoute
  workflowReturnRoute = null
  if (back?.name === "session" && typeof back.params?.sessionID === "string") {
    api.route.navigate("session", { sessionID: back.params.sessionID })
    return
  }
  api.route.navigate("home")
}

/** /workflow 全屏路由视图（多树同显版）：所有 run 逐树平铺，j/k 跨树上下选择，Enter 进子会话，Esc 返回。
 *  键位经 focus 作用域层接管；节点行复合选中键 runId 节点id 保证跨树唯一 */
function RouteView(props: { api: TuiPluginApi; sessionID?: string }) {
  const theme = () => props.api.theme.current
  const progresses = props.sessionID
    ? getOrCreateProgress(props.api, props.sessionID, props.api.lifecycle.onDispose)
    : () => []
  const rows = () => buildMultiRunRows(progresses())
  const keys = () => selectableNodeKeys(rows())
  // 滚动跟随：行渲染体的 id 登记表 + 滚动容器引用，选中越屏时 scrollChildIntoView
  const rowRenderableIds = new Map<string, string>()
  let scrollBox: { scrollChildIntoView(childId: string): void } | undefined

  const move = (delta: number) => {
    const next = moveSelection(keys(), selectedNode(), delta)
    if (next === undefined) return
    setSelectedNode(next)
    const childId = rowRenderableIds.get(next)
    if (childId) scrollBox?.scrollChildIntoView(childId)
  }
  const openSelected = () => {
    // Node Inspector：Enter 进节点详情（含 result 展示），子会话经详情内 Open Session 进入
    const found = findSelectedRunNode(progresses(), selectedNode())
    if (!found) return
    disposeNavLayer?.()
    disposeNavLayer = undefined
    props.api.route.navigate(NODE_DETAIL_ROUTE, {
      sessionID: props.sessionID,
      runId: found.runId,
      nodeId: found.node.id,
      returnRoute: { name: WORKFLOW_ROUTE, params: { sessionID: props.sessionID } },
    })
  }

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme().background}
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
      ref={(el: Renderable) => {
        // 抢焦点 + 注册 focus 作用域键位层（进入路由即接管键盘）
        el.focusable = true
        el.focus()
        disposeNavLayer?.()
        disposeNavLayer = props.api.keymap.registerLayer({
          target: el,
          targetMode: "focus",
          commands: [
            { name: "workflow.nav.up", run: () => move(-1) },
            { name: "workflow.nav.down", run: () => move(1) },
            { name: "workflow.nav.open", run: () => openSelected() },
            { name: "workflow.nav.back", run: () => navigateBack(props.api) },
          ],
          bindings: [
            { key: "up,k", cmd: "workflow.nav.up", desc: "Previous agent" },
            { key: "down,j", cmd: "workflow.nav.down", desc: "Next agent" },
            { key: "enter", cmd: "workflow.nav.open", desc: "Open agent session" },
            { key: "escape,q", cmd: "workflow.nav.back", desc: "Back" },
          ],
        })
      }}
    >
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <text fg={theme().text}>
          <b>Workflow</b> {progresses().length > 0 ? `${progresses().length} 个 run` : "-"}
        </text>
        <For each={progresses()}>
          {(p) => (
            <text fg={theme().textMuted}>
              {p.name} {p.status} · {p.completed}/{p.total}
              {p.running > 0 ? ` · ${p.running} running` : ""}
              {p.failed > 0 ? ` · ${p.failed} failed` : ""}
            </text>
          )}
        </For>
      </box>
      <scrollbox
        flexGrow={1}
        ref={(el: { scrollChildIntoView(childId: string): void; id: string }) => {
          scrollBox = el
        }}
      >
        <For each={rows()}>
          {(row) => {
            if (row.kind === "run") {
              return (
                <box paddingTop={1}>
                  <text fg={theme().text}>
                    <b>{row.title}</b>
                  </text>
                </box>
              )
            }
            if (row.kind === "phase") {
              return (
                <box paddingLeft={2} paddingTop={1}>
                  <text fg={theme().textMuted}>{row.title}</text>
                </box>
              )
            }
            const meta = getNodeMeta(row.node.status)
            const key = selectionKey(row.runId, row.node.id)
            const selected = selectedNode() === key
            return (
              <box
                flexDirection="row"
                paddingLeft={2}
                backgroundColor={selected ? theme().backgroundPanel : undefined}
                ref={(el: { id: string }) => {
                  // 登记行渲染体 id，选中越屏时 scrollChildIntoView 跟随
                  rowRenderableIds.set(key, el.id)
                }}
              >
                <box width={2}>
                  <text fg={selected ? theme().text : theme().textMuted}>{selected ? "▸ " : "  "}</text>
                </box>
                <box width={2}>
                  <text fg={toneColor(props.api, meta.tone)}>{meta.icon} </text>
                </box>
                <box flexGrow={1}>
                  <text fg={toneColor(props.api, meta.tone)} wrapMode="word">
                    {routeNodeLine(row.node)}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
        <Show when={progresses().length === 0}>
          <box paddingTop={1}>
            <text fg={theme().textMuted}>当前不在会话中打开，或该会话还没有 workflow 运行记录</text>
          </box>
        </Show>
      </scrollbox>
      <box flexGrow={1} />
      <box paddingTop={1}>
        <text fg={theme().textMuted}>j/k 上下选择 · Enter 节点详情 · Esc 返回</text>
      </box>
    </box>
  )
}

/**
 * 节点详情全屏视图（Node Inspector，FR-4）：展示单个 workflow 节点的执行元数据与 result。
 * 数据双通道：节点状态走快照信号（复用 getOrCreateProgress 的 1s 轮询，完成后自动刷新）；
 * result 内容走 journal 文件按需读取（挂载即读 + 轮询 diff 守卫 + 状态翻转立即重读）。
 * 快照被新 run 清理时（终态快照有生命周期），header 由 journal entry 元数据回填。
 * 键位：Enter/o 打开子会话（Open Session，sessionId 取自节点）· Esc/q 返回来源路由。
 */
function NodeDetailView(props: {
  api: TuiPluginApi
  sessionID?: string
  runId?: string
  nodeId?: string
  returnRoute?: { name: string; params?: Record<string, unknown> }
}) {
  const theme = () => props.api.theme.current
  const progresses = props.sessionID
    ? getOrCreateProgress(props.api, props.sessionID, props.api.lifecycle.onDispose)
    : () => []

  // ---- journal 内容通道 ----
  const [entry, setEntry] = createSignal<JournalEntryView | null>(null)
  let lastRaw: string | null = null
  const reloadJournal = () => {
    if (!props.runId || !props.nodeId) return
    let directory: string | undefined
    try {
      directory = props.sessionID
        ? props.api.state.session.get(props.sessionID)?.directory ?? props.api.state.path.directory
        : props.api.state.path.directory
    } catch {
      return
    }
    if (!directory) return
    // diff 守卫：原文未变不重解析（大 journal 每秒成本 = 一次读文件 + 字符串比较）
    const raw = readJournalRaw(directory, props.runId)
    if (raw === null || raw === lastRaw) return
    lastRaw = raw
    setEntry(parseJournalFile(raw)?.get(props.nodeId) ?? null)
  }
  reloadJournal()
  const journalPoll = setInterval(reloadJournal, POLL_INTERVAL_MS)
  props.api.lifecycle.onDispose(() => clearInterval(journalPoll))

  // ---- 节点视图：快照优先，快照消失时由 journal 元数据合成（历史 run 的 result 仍可看）----
  const node = (): WorkflowNode | null => {
    if (!props.runId || !props.nodeId) return null
    for (const progress of progresses()) {
      if (progress.runId !== props.runId) continue
      for (const n of progress.nodes) {
        if (n.id === props.nodeId) return n
      }
    }
    return null
  }
  const view = (): WorkflowNode | null => {
    const n = node()
    if (n) return n
    const e = entry()
    if (!e) return null
    return {
      id: props.nodeId ?? "",
      label: e.label ?? props.nodeId ?? "",
      phase: e.phase,
      // journal 有 entry 说明该节点成功写入过结果
      status: "ok",
      model: e.model,
      sessionId: e.sessionId,
      durationMs: e.durationMs,
      executionId: e.executionId,
      attempt: e.attempt,
      outputType: e.outputType === "text" || e.outputType === "structured" ? e.outputType : undefined,
      inputTokens: e.usage?.inputTokens,
      outputTokens: e.usage?.outputTokens,
    }
  }
  // 节点状态翻转（running -> ok/failed）时立即重读 journal：结果即时可见，不等下一轮询
  createEffect(() => {
    node()?.status
    reloadJournal()
  })

  // ---- Result 展示状态（空态三分 + 正文）----
  const resultState = () =>
    resolveResultState({
      status: view()?.status ?? "running",
      error: view()?.error,
      entry: entry(),
      preview: view()?.outputPreview,
    })

  // ---- 操作 ----
  const openSession = () => {
    const sessionId = view()?.sessionId
    if (!sessionId) return
    disposeNavLayer?.()
    disposeNavLayer = undefined
    props.api.route.navigate("session", { sessionID: sessionId })
  }
  const backFromDetail = () => {
    disposeNavLayer?.()
    disposeNavLayer = undefined
    const back = props.returnRoute
    if (back) {
      props.api.route.navigate(back.name, back.params)
      return
    }
    props.api.route.navigate("home")
  }

  const headerMeta = () => getNodeMeta(view()?.status ?? "running")
  const agentTypeLine = () => {
    const e = entry()
    return e?.agentType ?? "explore"
  }
  const promptPreview = () => {
    const prompt = entry()?.prompt
    if (!prompt) return undefined
    const truncated = truncateUtf8ByBytes(prompt, 512)
    return truncated.length < prompt.length ? `${truncated}...` : truncated
  }

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme().background}
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
      ref={(el: Renderable) => {
        // 抢焦点 + 注册 focus 作用域键位层（进入路由即接管键盘）
        el.focusable = true
        el.focus()
        disposeNavLayer?.()
        disposeNavLayer = props.api.keymap.registerLayer({
          target: el,
          targetMode: "focus",
          commands: [
            { name: "workflow.node.open", run: () => openSession() },
            { name: "workflow.node.back", run: () => backFromDetail() },
          ],
          bindings: [
            { key: "enter,o", cmd: "workflow.node.open", desc: "Open agent session" },
            { key: "escape,q", cmd: "workflow.node.back", desc: "Back" },
          ],
        })
      }}
    >
      <Show
        when={view()}
        fallback={
          <box paddingTop={1}>
            <text fg={theme().textMuted}>
              找不到该节点的数据（快照与 journal 均无记录），参数可能有误或运行数据已被清理
            </text>
          </box>
        }
      >
        {(current: () => WorkflowNode) => (
          <>
            {/* Header 区：label 与状态 */}
            <box flexDirection="row" gap={1} paddingBottom={1}>
              <text fg={toneColor(props.api, headerMeta().tone)}>
                {headerMeta().icon} <b>{current().label}</b>
              </text>
              <text fg={toneColor(props.api, headerMeta().tone)}>{current().status}</text>
              <Show when={(current().attempt ?? 1) > 1}>
                <text fg={theme().textMuted}>第 {current().attempt} 次执行</text>
              </Show>
              <Show when={current().replayed}>
                <text fg={theme().textMuted}>缓存回放</text>
              </Show>
            </box>
            {/* Header 区：执行元数据 */}
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted}>
                agent {agentTypeLine()}
                {current().model ? ` · ${current().model}` : ""}
                {current().durationMs !== undefined ? ` · ${formatDuration(current().durationMs)}` : ""}
                {current().tokens !== undefined ? ` · ${formatTokens(current().tokens)} tok` : ""}
                {current().inputTokens !== undefined || current().outputTokens !== undefined
                  ? ` (in ${formatTokens(current().inputTokens)} / out ${formatTokens(current().outputTokens)})`
                  : ""}
              </text>
            </box>
            {/* Header 区：标识符 */}
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted}>
                {current().sessionId ? `session ${current().sessionId}` : "session -"}
                {" · "}run {props.runId ?? "-"}
                {current().executionId ? ` · exec ${current().executionId}` : ""}
              </text>
            </box>
            <Show when={promptPreview()}>
              {(prompt: () => string) => (
                <box paddingLeft={1} paddingTop={1}>
                  <text fg={theme().textMuted} wrapMode="word">
                    prompt: {prompt()}
                  </text>
                </box>
              )}
            </Show>
            {/* Result 区 */}
            <scrollbox flexGrow={1} paddingTop={1}>
              {(() => {
                const state = resultState()
                if (state.state === "error") {
                  return <text fg={theme().error} wrapMode="word">Error: {state.message}</text>
                }
                if (state.state === "pending") {
                  return <text fg={theme().warning}>No result yet</text>
                }
                if (state.state === "empty") {
                  return <text fg={theme().textMuted}>No result returned</text>
                }
                return (
                  <box flexDirection="column">
                    <Show when={state.source === "preview"}>
                      <box paddingBottom={1}>
                        <text fg={theme().textMuted}>（快照预览，journal 未写入完整结果）</text>
                      </box>
                    </Show>
                    <text fg={theme().text} wrapMode="word">
                      {state.view.body}
                    </text>
                    <Show when={state.view.truncated}>
                      <box paddingTop={1}>
                        <text fg={theme().warning}>
                          Result truncated, original size: {(state.view.originalBytes / 1024).toFixed(1)} KB
                        </text>
                      </box>
                    </Show>
                  </box>
                )
              })()}
            </scrollbox>
            {/* 操作区：键位提示 */}
            <box paddingTop={1}>
              <text fg={theme().textMuted}>
                {view()?.sessionId ? "Enter/o Open Session · " : ""}Esc/q 返回 · 滚轮滚动正文
              </text>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}

/** 输入框右侧状态条（session_prompt_right 插槽）：所有运行中的 workflow 各占一行进度摘要 */
function PromptFooterView(props: { api: TuiPluginApi; session_id: string }) {
  const progresses = getOrCreateProgress(props.api, props.session_id, props.api.lifecycle.onDispose)
  const lines = () =>
    progresses()
      .filter((p) => p.status === "running")
      .map((p) => `◐ workflow ${p.name} ${p.completed}/${p.total}${p.running > 0 ? ` · ${p.running} running` : ""}`)
  return (
    <Show when={lines().length > 0}>
      <For each={lines()}>{(line) => <text fg={toneColor(props.api, "warning")}>{line}</text>}</For>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350, // 内置 LSP(300) 之后、Todo(400) 之前
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
      session_prompt_right(_ctx, props) {
        return <PromptFooterView api={api} session_id={props.session_id} />
      },
    },
  })

  // MVP-3：workflow 全屏路由 + 命令面板入口（无绑定的命令层，不占任何全局键）
  // Node Inspector：节点详情路由（params 携 runId/nodeId/returnRoute，从 sidebar 点击或列表 Enter 进入）
  api.route.register([
    {
      name: WORKFLOW_ROUTE,
      render: ({ params }) => (
        <RouteView api={api} sessionID={typeof params?.sessionID === "string" ? params.sessionID : undefined} />
      ),
    },
    {
      name: NODE_DETAIL_ROUTE,
      render: ({ params }) => (
        <NodeDetailView
          api={api}
          sessionID={typeof params?.sessionID === "string" ? params.sessionID : undefined}
          runId={typeof params?.runId === "string" ? params.runId : undefined}
          nodeId={typeof params?.nodeId === "string" ? params.nodeId : undefined}
          returnRoute={
            params?.returnRoute as { name: string; params?: Record<string, unknown> } | undefined
          }
        />
      ),
    },
  ])
  api.keymap.registerLayer({
    commands: [
      {
        name: "workflow.view.open",
        title: "Open workflow view",
        slashName: "workflow",
        category: "Workflow",
        namespace: "palette",
        run() {
          const current = api.route.current
          const sessionID = current.name === "session" ? current.params?.sessionID : undefined
          workflowReturnRoute =
            current.name === "session"
              ? { name: "session", params: current.params as Record<string, unknown> | undefined }
              : current.name === "home"
                ? { name: "home" }
                : null
          api.route.navigate(WORKFLOW_ROUTE, sessionID ? { sessionID } : undefined)
        },
      },
    ],
  })
}

const plugin: TuiPluginModule = {
  id,
  tui,
}

export default plugin
