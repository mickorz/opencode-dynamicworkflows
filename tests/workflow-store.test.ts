/**
 * TUI 侧 workflow-store 测试（F-20 MVP-1 前台通道 TUI 侧，纯逻辑无 solid）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSidebarRows,
  buildMultiRunRows,
  findSelectedRunNode,
  findWorkflowMetadata,
  formatDuration,
  formatElapsed,
  formatTokens,
  moveSelection,
  nodeLine,
  parseWorkflowMetadata,
  phaseElapsedMs,
  progressViewKey,
  selectableNodeKeys,
  sumTokens,
  type ToolPartLike,
  type WorkflowNode,
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

test("buildSidebarRows：phase 变化处插标题行，无 phase 平铺；子流程一级分组（v0.9）", () => {
  const p = parseWorkflowMetadata(VALID)!
  const rows = buildSidebarRows(p)
  assert.deepEqual(
    rows.map((r) => (r.kind === "phase" ? `#${r.title}` : r.kind === "workflow" ? `@${r.title}` : r.node.label)),
    ["#Analyze", "解释1", "解释2", "#Summarize", "汇总"],
  )
  // 无 phase 的节点不产生标题行
  const plain = buildSidebarRows(parseWorkflowMetadata({ runId: "r", agents: VALID.agents.map((a) => ({ ...a, phase: undefined })) })!)
  assert.deepEqual(
    plain.map((r) => r.kind),
    ["node", "node", "node"],
  )
  // 子流程节点：workflowPath[0] 变化处插 workflow 分组行，换组后 phase 重新起头
  const wfRows = buildSidebarRows(
    parseWorkflowMetadata({
      runId: "r2",
      agents: [
        { ...VALID.agents[0], phase: "▸ ds / 生成", workflowPath: ["ds"] },
        { ...VALID.agents[1], phase: "▸ ds / 校验", workflowPath: ["ds"] },
        { ...VALID.agents[2], phase: "▸ gpt / 生成", workflowPath: ["gpt"] },
        { ...VALID.agents[0], phase: "▸ gpt / 校验", workflowPath: ["gpt"] },
      ],
    })!,
  )
  assert.deepEqual(
    wfRows.map((r) => (r.kind === "phase" ? `#${r.title}` : r.kind === "workflow" ? `@${r.title}` : r.node.label)),
    ["@ds", "#▸ ds / 生成", "解释1", "#▸ ds / 校验", "解释2", "@gpt", "#▸ gpt / 生成", "汇总", "#▸ gpt / 校验", "解释1"],
  )
})

test("formatDuration：三档展示", () => {
  assert.equal(formatDuration(843), "843ms")
  assert.equal(formatDuration(12300), "12.3s")
  assert.equal(formatDuration(75000), "1m15s")
  assert.equal(formatDuration(undefined), "")
})

test("selectableNodeKeys 与 moveSelection：键盘导航基础（MVP-3 与 多树复合键）", () => {
  const p = parseWorkflowMetadata(VALID)!
  const rows = buildMultiRunRows([p])
  const ids = selectableNodeKeys(rows)
  assert.deepEqual(ids, ["run-x:run-x:0", "run-x:run-x:1", "run-x:run-x:2"]) // phase 与 run 标题行不可选，键为 runId 节点id

  // 无选中时：正向下取首个，向上取末个
  assert.equal(moveSelection(ids, null, 1), ids[0])
  assert.equal(moveSelection(ids, null, -1), ids[2])
  // 常规移动
  assert.equal(moveSelection(ids, ids[0], 1), ids[1])
  assert.equal(moveSelection(ids, ids[2], -1), ids[1])
  // 越界回绕
  assert.equal(moveSelection(ids, ids[2], 1), ids[0])
  assert.equal(moveSelection(ids, ids[0], -1), ids[2])
  // 选中键已不在列表（树已刷新）时重新锚定
  assert.equal(moveSelection(ids, "gone", 1), ids[0])
  // 空列表安全
  assert.equal(moveSelection([], null, 1), undefined)
})

test("formatTokens：千分位缩写（k 与 m，保留一位小数）", () => {
  assert.equal(formatTokens(undefined), "")
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1000), "1.0k")
  assert.equal(formatTokens(9876), "9.9k")
  assert.equal(formatTokens(123_456), "123.5k")
  assert.equal(formatTokens(1_000_000), "1.0m")
  assert.equal(formatTokens(1_234_567), "1.2m")
})

test("sumTokens：全部节点 token 合计，缺省按 0", () => {
  const p = parseWorkflowMetadata({
    runId: "r",
    agents: [
      { id: "r:0", label: "a", status: "ok", tokens: 9876 },
      { id: "r:1", label: "b", status: "running" },
      { id: "r:2", label: "c", status: "ok", tokens: 200 },
    ],
  })!
  assert.equal(sumTokens(p), 10_076)
})

// ---- Node Inspector 扩展 ----

test("parseWorkflowMetadata：提取 Node Inspector 新字段；老形状无新字段不回归", () => {
  const p = parseWorkflowMetadata({
    runId: "r",
    agents: [
      {
        id: "r:0", label: "新节点", status: "ok",
        executionId: "r:0:2", attempt: 2, outputType: "structured",
        outputPreview: "{\n  \"ok\": true\n}", inputTokens: 30, outputTokens: 20,
      },
      { id: "r:1", label: "老节点", status: "running" },
    ],
  })!
  const [fresh, legacy] = p.nodes
  assert.equal(fresh.executionId, "r:0:2")
  assert.equal(fresh.attempt, 2)
  assert.equal(fresh.outputType, "structured")
  assert.equal(fresh.outputPreview, '{\n  "ok": true\n}')
  assert.equal(fresh.inputTokens, 30)
  assert.equal(fresh.outputTokens, 20)
  // 老形状：新字段 undefined，不崩
  assert.equal(legacy.executionId, undefined)
  assert.equal(legacy.outputType, undefined)
  assert.equal(legacy.outputPreview, undefined)
  // 坏形状字段被清洗（outputType 非法枚举丢弃）
  const dirty = parseWorkflowMetadata({
    runId: "r",
    agents: [{ id: "r:0", label: "x", status: "ok", outputType: "weird", attempt: "two" }],
  })!
  assert.equal(dirty.nodes[0].outputType, undefined)
  assert.equal(dirty.nodes[0].attempt, undefined)
})

test("findSelectedRunNode：跨树命中并携带所属 runId", () => {
  const a = parseWorkflowMetadata({ runId: "run-a", agents: [{ id: "run-a:0", label: "x", status: "ok" }] })!
  const b = parseWorkflowMetadata({ runId: "run-b", agents: [{ id: "run-b:0", label: "y", status: "ok" }] })!
  const progresses = [a, b]
  const found = findSelectedRunNode(progresses, "run-b:run-b:0")
  assert.ok(found)
  assert.equal(found!.runId, "run-b")
  assert.equal(found!.node.label, "y")
  assert.equal(findSelectedRunNode(progresses, "run-a:run-a:0")!.runId, "run-a")
  assert.equal(findSelectedRunNode(progresses, null), undefined)
  assert.equal(findSelectedRunNode(progresses, "不存在"), undefined)
})

test("phaseElapsedMs：running 递增、完成定格、无 startedAt 返回 undefined", () => {
  const mk = (over: Partial<WorkflowNode>): WorkflowNode => ({
    id: "n",
    label: "n",
    status: "ok",
    ...over,
  })
  // running：now - 最早 startedAt（并行重叠取最早）
  const running = [
    mk({ startedAt: 1000, durationMs: 500, status: "running" }),
    mk({ startedAt: 3000, durationMs: 0, status: "running" }),
  ]
  assert.equal(phaseElapsedMs(running, 8000), 7000)
  // 完成：max(startedAt+durationMs) - min(startedAt)，重叠不重复计费
  const done = [
    mk({ startedAt: 1000, durationMs: 5000 }),
    mk({ startedAt: 3000, durationMs: 9000 }),
  ]
  assert.equal(phaseElapsedMs(done, 999999), 11000)
  // 全回放/老快照：无 startedAt 不显示
  assert.equal(phaseElapsedMs([mk({ durationMs: 100 })], 999999), undefined)
  // 混合：running 存在则按 now 递增
  const mixed = [mk({ startedAt: 1000, durationMs: 2000 }), mk({ startedAt: 4000, status: "running" })]
  assert.equal(phaseElapsedMs(mixed, 6000), 5000)
})

test("formatElapsed：整数秒，不带小数", () => {
  assert.equal(formatElapsed(0), "0s")
  assert.equal(formatElapsed(999), "0s")
  assert.equal(formatElapsed(23000), "23s")
  assert.equal(formatElapsed(65000), "1m05s")
  assert.equal(formatElapsed(125000), "2m05s")
})

test("nodeLine：running 有 startedAt 显示整数秒实时耗时，完成态保持一位小数", () => {
  const now = Date.now()
  const running: WorkflowNode = { id: "n", label: "核查", status: "running", startedAt: now - 8400 }
  assert.match(nodeLine(running), /^核查 ·8s$/)
  const done: WorkflowNode = { id: "n", label: "核查", status: "ok", durationMs: 8400, tokens: 1234 }
  assert.equal(nodeLine(done), "核查 ·8.4s ·1.2k tok")
})

test("parseWorkflowMetadata：解析 startedAt；老快照无此字段不回归", () => {
  const withTs = parseWorkflowMetadata({
    runId: "r",
    status: "running",
    agents: [{ id: "r:0", label: "a", status: "running", startedAt: 123456 }],
  })
  assert.equal(withTs!.nodes[0].startedAt, 123456)
  const legacy = parseWorkflowMetadata({
    runId: "r",
    status: "running",
    agents: [{ id: "r:0", label: "a", status: "running" }],
  })
  assert.equal(legacy!.nodes[0].startedAt, undefined)
})

test("progressViewKey：混入 time，仅心跳时间变化也触发重渲染", () => {
  const base = {
    runId: "r",
    name: "w",
    status: "running" as const,
    phases: [],
    nodes: [],
    running: 1,
    completed: 0,
    failed: 0,
    total: 1,
  }
  // 同状态不同 time（快照心跳）-> key 不同 -> setProgress 生效 -> 耗时递增可刷新
  assert.notEqual(progressViewKey({ ...base, time: 1000 }), progressViewKey({ ...base, time: 4000 }))
  // metadata 通道无 time（undefined）与 0 等价，保持稳定
  assert.equal(progressViewKey({ ...base }), progressViewKey({ ...base, time: undefined }))
})

test("buildSidebarRows：composite 链分组行（P2-3）——进入插行、嵌套缩进、退出不发、重入重发", () => {
  const agents = [
    { ...VALID.agents[0], compositePath: ["cmp0"] },
    { ...VALID.agents[1], compositePath: ["cmp0"] },
    { ...VALID.agents[2], compositePath: ["cmp0", "cmp1"] },
    { ...VALID.agents[0] },
    { ...VALID.agents[1], compositePath: ["cmp0"] },
  ]
  const rows = buildSidebarRows(
    parseWorkflowMetadata({
      runId: "r3",
      agents,
      composites: [
        { id: "cmp0", kind: "sequence", label: "Sequence", status: "ok", compositePath: ["cmp0"] },
        { id: "cmp1", kind: "fallback", label: "Fallback", status: "ok", compositePath: ["cmp0", "cmp1"] },
      ],
    })!,
  )
  const shape = rows.map((r) =>
    r.kind === "composite" ? `[${r.title}]` : r.kind === "node" ? r.node.label : `#${r.title}`,
  )
  assert.deepEqual(shape, [
    "[Sequence]",
    "#Analyze",
    "解释1",
    "解释2",
    "[  Fallback]", // 嵌套第二段：深度 1 缩进
    "#Summarize",
    "汇总",
    "#Analyze", // 退出组合：不发关闭行，phase 正常变化
    "解释1",
    "[Sequence]", // 重入 cmp0：重新发分组行（时间线式语义，与 workflow 行一致）
    "#Analyze", // 换组合后 phase 重新起头（与 workflow 换组行为一致）
    "解释2",
  ])
})

test("buildSidebarRows：composites 记录缺失时用段 id 兜底显示", () => {
  const rows = buildSidebarRows(
    parseWorkflowMetadata({
      runId: "r4",
      agents: [{ ...VALID.agents[0], compositePath: ["cmp7"] }],
    })!,
  )
  assert.deepEqual(
    rows.map((r) => (r.kind === "composite" ? r.title : r.kind === "phase" ? `#${r.title}` : r.node.label)),
    ["cmp7", "#Analyze", "解释1"],
  )
})
