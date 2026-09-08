/** @jsxImportSource @opentui/solid */
/**
 * Dynamic Workflow TUI 插件实现（F-20 / MVP-1 前台通道的渲染端）
 *
 * 本文件是 src/tui/ 内唯一碰 solid-js 的文件（需求文档 9.3：
 * 跨文件分散 solid 用法会解析出不同 solid-js 实例，信号跨文件失效）。
 * 数据提取与行组装在 workflow-store.ts（纯 ts）。
 *
 * 骨架照搬 opencode-subagents-view（MIT）的 plugin.tsx：
 *  - 折叠信号按 session 缓存于模块级 Map，重复渲染复用而非重建
 *  - sidebar_content 插槽 order:350（内置 LSP=300 之后、Todo=400 之前）
 */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Renderable } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import {
  buildMultiRunRows,
  buildSidebarRows,
  findSelectedNode,
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

const id = "opencode-dynamic-workflows"

/** workflow 全屏路由名（MVP-3）：api.route.register + 命令面板打开，Enter 进子会话的键盘导航在本路由内 */
const WORKFLOW_ROUTE = "opencode-dynamic-workflows.workflow"
/** 打开路由前的来源路由（Esc 返回用；module 级存单例，路由同时只有一个实例） */
let workflowReturnRoute: { name: string; params?: Record<string, unknown> } | null = null
/** 路由内选中节点（solid signal，跨副本闭环在本文件内） */
const [selectedNode, setSelectedNode] = createSignal<string | null>(null)
/** 路由键位层 disposer（焦点作用域，target 失焦即失效；离开路由时主动清，防悬挂） */
let disposeNavLayer: (() => void) | undefined

/** 节点状态图标与主题色调（几何符号非 emoji；照搬 subagents-view 的图标语义） */
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
 * 跨副本的依赖追踪不生效（Read 一次后永不更新，需求文档 9.3 的教训；
 * subagents-view 因此同样只用 api.event.on 镜像数据到自己 signal）。
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
                {/* MVP-2：带 sessionId 的节点可点击进入子会话 */}
                <box
                  flexDirection="row"
                  onMouseDown={row.node.sessionId ? () => props.api.route.navigate("session", { sessionID: row.node.sessionId }) : undefined}
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
  if (node.sessionId) parts.push("[Enter 进入]")
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
    const node = findSelectedNode(progresses(), selectedNode())
    if (!node?.sessionId) return
    disposeNavLayer?.()
    disposeNavLayer = undefined
    props.api.route.navigate("session", { sessionID: node.sessionId })
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
        <text fg={theme().textMuted}>j/k 上下选择 · Enter 进入子会话 · Esc 返回</text>
      </box>
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
  api.route.register([
    {
      name: WORKFLOW_ROUTE,
      render: ({ params }) => (
        <RouteView api={api} sessionID={typeof params?.sessionID === "string" ? params.sessionID : undefined} />
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
