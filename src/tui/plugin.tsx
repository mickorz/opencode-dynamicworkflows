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
import { For, Show, createSignal } from "solid-js"
import {
  buildSidebarRows,
  findWorkflowMetadata,
  formatDuration,
  parseWorkflowMetadata,
  pickBestProgress,
  progressViewKey,
  type WorkflowNode,
  type WorkflowProgress,
} from "./workflow-store.js"
import { listSessionSnapshots } from "./run-snapshot-reader.js"

const id = "opencode-dynamic-workflows"

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

/** 折叠状态按 session 缓存（重复渲染必须复用信号，不能每次重建——subagents-view 踩坑结论） */
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
const progressBySession = new Map<string, () => WorkflowProgress | null>()

function computeProgress(api: TuiPluginApi, sessionId: string): WorkflowProgress | null {
  // 双通道合并：镜像快照（B）新鲜则优先，否则 tool 返回值 metadata（C）兑底
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
  return pickBestProgress(snapshots, metadataProgress, Date.now())
}

/** 快照轮询间隔（omo 同款，agent 粒度变化频率下够用） */
const POLL_INTERVAL_MS = 1000

function getOrCreateProgress(
  api: TuiPluginApi,
  sessionId: string,
  onDispose: (fn: () => void) => void,
): () => WorkflowProgress | null {
  const cached = progressBySession.get(sessionId)
  if (cached) return cached

  const [progress, setProgress] = createSignal<WorkflowProgress | null>(computeProgress(api, sessionId))
  // viewKey 差分：内容未变不写 signal，避免轮询驱动的无谓重渲
  let lastKey = progressViewKey(progress())
  const applyProgress = (next: WorkflowProgress | null) => {
    const key = progressViewKey(next)
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
    applyProgress(computeProgress(api, sessionId))
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
  onDispose: (fn: () => void) => void,
): [() => boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const cached = collapsedBySession.get(sessionId)
  if (cached) return [cached.collapsed, cached.setCollapsed]

  const [collapsed, setCollapsed] = createSignal(false)
  onDispose(() => collapsedBySession.delete(sessionId))
  collapsedBySession.set(sessionId, { collapsed, setCollapsed })
  return [collapsed, setCollapsed]
}

function headerLine(progress: WorkflowProgress): string {
  const suffix =
    progress.status === "running" && progress.running > 0 ? ` | ${progress.running} running` : ""
  return `${progress.name} (${progress.completed}/${progress.total}${suffix})`
}

function nodeLine(node: WorkflowNode): string {
  const duration = formatDuration(node.durationMs)
  const replayed = node.replayed ? " ·缓存" : ""
  const durationPart = duration ? ` ·${duration}` : ""
  return `${node.label}${durationPart}${replayed}`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const progress = getOrCreateProgress(props.api, props.session_id, props.api.lifecycle.onDispose)
  const [collapsed, setCollapsed] = getOrCreateCollapsed(props.session_id, props.api.lifecycle.onDispose)
  const rows = () => {
    const current = progress()
    return current ? buildSidebarRows(current) : []
  }

  return (
    <Show when={progress()}>
      <box onMouseDown={() => setCollapsed((current) => !current)}>
        <text fg={theme().text}>
          <b>{collapsed() ? "▶" : "▼"} Dynamic Workflow</b> {headerLine(progress()!)}
        </text>
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
                  <box flexDirection="row">
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
    },
  })
}

const plugin: TuiPluginModule = {
  id,
  tui,
}

export default plugin
