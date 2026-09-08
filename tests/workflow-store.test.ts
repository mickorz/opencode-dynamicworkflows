/**
 * TUI 侧 workflow-store 测试（F-20 MVP-1 前台通道 TUI 侧，纯逻辑无 solid）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSidebarRows,
  findWorkflowMetadata,
  formatDuration,
  moveSelection,
  parseWorkflowMetadata,
  selectableNodeIds,
  type ToolPartLike,
} from "../src/tui/workflow-store.js"

const VALID = {
  runId: "run-x",
  name: "demo",
  status: "running",
  agents: [
    { id: "run-x:0", label: "解释1", phase: "Analyze", status: "ok", durationMs: 1200, sessionId: "c1" },
    { id: "run-x:1", label: "解释2", phase: "Analyze", status: "running", sessionId: "c2" },
    { id: "run-x:2", label: "汇总", phase: "Summarize", status: "failed", error: "boom" },
  ],
}

test("parseWorkflowMetadata：合法形状解析出计数与 phases", () => {
  const p = parseWorkflowMetadata(VALID)
  assert.ok(p)
  assert.equal(p.name, "demo")
  assert.equal(p.status, "running")
  assert.deepEqual(p.phases, ["Analyze", "Summarize"])
  assert.equal(p.running, 1)
  assert.equal(p.completed, 1)
  assert.equal(p.failed, 1)
  assert.equal(p.total, 3)
  assert.equal(p.nodes[0].sessionId, "c1")
})

test("parseWorkflowMetadata：非法形状返回 null（metadata 是 any，防崩）", () => {
  assert.equal(parseWorkflowMetadata(undefined), null)
  assert.equal(parseWorkflowMetadata("string"), null)
  assert.equal(parseWorkflowMetadata({ agents: [] }), null) // 缺 runId
  assert.equal(parseWorkflowMetadata({ runId: "r", agents: "no" }), null) // agents 非数组
  assert.equal(parseWorkflowMetadata({ runId: "r", agents: [{ id: 1, label: "x", status: "ok" }] }), null) // 节点缺 string 字段
  assert.equal(parseWorkflowMetadata({ runId: "r", agents: [] }), null) // 空节点视为无 workflow
})

test("parseWorkflowMetadata：字段宽松清洗 + 缺省回退", () => {
  const p = parseWorkflowMetadata({
    runId: "r",
    agents: [
      {
        id: "r:0",
        label: "x",
        status: "ok",
        phase: 42, // 非法 phase 清洗为 undefined
        durationMs: "fast", // 非法耗时清洗
        replayed: true,
        extra: "ignored",
      },
    ],
  })
  assert.ok(p)
  assert.equal(p.name, "workflow") // 缺 name 回退
  assert.equal(p.status, "running") // 非法 status 回退 running
  assert.equal(p.nodes[0].phase, undefined)
  assert.equal(p.nodes[0].durationMs, undefined)
  assert.equal(p.nodes[0].replayed, true)
})

test("findWorkflowMetadata：从后往前取最近一次 workflow tool part（parts 经 messageID 单独取）", () => {
  // TUI sync store：message 不带内联 parts，part 按 messageID 分开存
  const messages = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]
  const partsByMessage: Record<string, ToolPartLike[]> = {
    m1: [{ type: "tool", tool: "workflow", state: { metadata: { runId: "old" } } }],
    m2: [{ type: "tool", tool: "read", state: { metadata: { runId: "noise" } } }],
    m3: [{ type: "tool", tool: "workflow", state: { metadata: { runId: "new" } } }],
  }
  const getParts = (mid: string) => partsByMessage[mid]
  assert.equal((findWorkflowMetadata(messages, getParts) as { runId: string }).runId, "new")
  // 同一消息内多个 tool part：取最后一个 workflow
  partsByMessage.m3.push({ type: "tool", tool: "workflow", state: { metadata: { runId: "newest" } } })
  assert.equal((findWorkflowMetadata(messages, getParts) as { runId: string }).runId, "newest")
  // 无消息/无 part/无 id 均安全返回 undefined
  assert.equal(findWorkflowMetadata([], getParts), undefined)
  assert.equal(findWorkflowMetadata([{ id: "m1" }], () => []), undefined)
  assert.equal(findWorkflowMetadata([{ nope: 1 } as { id?: string }], getParts), undefined)
})

test("buildSidebarRows：phase 变化处插标题行，无 phase 平铺", () => {
  const p = parseWorkflowMetadata(VALID)!
  const rows = buildSidebarRows(p)
  assert.deepEqual(
    rows.map((r) => (r.kind === "phase" ? `#${r.title}` : r.node.label)),
    ["#Analyze", "解释1", "解释2", "#Summarize", "汇总"],
  )
  // 无 phase 的节点不产生标题行
  const plain = buildSidebarRows(parseWorkflowMetadata({ runId: "r", agents: VALID.agents.map((a) => ({ ...a, phase: undefined })) })!)
  assert.deepEqual(
    plain.map((r) => r.kind),
    ["node", "node", "node"],
  )
})

test("formatDuration：三档展示", () => {
  assert.equal(formatDuration(843), "843ms")
  assert.equal(formatDuration(12300), "12.3s")
  assert.equal(formatDuration(75000), "1m15s")
  assert.equal(formatDuration(undefined), "")
})

test("selectableNodeIds 与 moveSelection：键盘导航基础（MVP-3）", () => {
  const p = parseWorkflowMetadata(VALID)!
  const rows = buildSidebarRows(p)
  const ids = selectableNodeIds(rows)
  assert.deepEqual(ids, ["run-x:0", "run-x:1", "run-x:2"]) // phase 标题行不可选

  // 无选中时：正向下取首个，向上取末个
  assert.equal(moveSelection(ids, null, 1), "run-x:0")
  assert.equal(moveSelection(ids, null, -1), "run-x:2")
  // 常规移动
  assert.equal(moveSelection(ids, "run-x:0", 1), "run-x:1")
  assert.equal(moveSelection(ids, "run-x:2", -1), "run-x:1")
  // 越界回绕
  assert.equal(moveSelection(ids, "run-x:2", 1), "run-x:0")
  assert.equal(moveSelection(ids, "run-x:0", -1), "run-x:2")
  // 选中 id 已不在列表（树已刷新）时重新锚定
  assert.equal(moveSelection(ids, "gone", 1), "run-x:0")
  // 空列表安全
  assert.equal(moveSelection([], null, 1), undefined)
})
