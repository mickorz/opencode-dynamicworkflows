/**
 * 多树同显回归测试：两个 workflow 并存时 sidebar 不再在 run 之间横跳
 *
 * 背景（横跳根因）：旧 pickBestProgress 按 time 排序只取 snapshots[0]，双活 run
 * 心跳交错写时 snapshots[0] 在两 run 间摆动；叠加"终态残留 + 活快照抖动"时
 * 显示在旧 run 树与新 run 树之间反复切换。多树同显后每个 run 独立成树，
 * 不存在"二选一裁决"，天然消除横跳。
 *
 * 时间线模拟方式：每 tick 用 TUI 同款合并规则算应显示的树集合，断言每棵树
 * 独立存在且内容稳定（不因其他 run 的快照抖动而消失/被顶替）。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { pickAllProgresses, runCreatedAt, toProgress } from "../src/tui/run-snapshot-reader.js"
import {
  buildMultiRunRows,
  buildNestedRunRows,
  findSelectedNode,
  progressesViewKey,
  selectableNodeKeys,
  selectionKey,
  splitRunsByParent,
  type WorkflowProgress,
} from "../src/tui/workflow-store.js"
import type { RunSnapshotView } from "../src/tui/run-snapshot-reader.js"

function makeSnapshot(opts: { runId: string; status: RunSnapshotView["status"]; time: number }): RunSnapshotView {
  return {
    version: 1,
    runId: opts.runId,
    parentSessionId: "s1",
    name: opts.runId,
    status: opts.status,
    time: opts.time,
    phases: ["p1"],
    nodes: [{ id: "n0", label: "agent", status: opts.status === "running" ? "running" : "ok" }],
    running: opts.status === "running" ? 1 : 0,
    completed: opts.status === "running" ? 0 : 1,
    failed: 0,
    total: 1,
  }
}

/** 目录快照集合（listSessionSnapshots 保证 time 降序） */
const byTimeDesc = (files: RunSnapshotView[]) => files.sort((a, b) => b.time - a.time)

test("回归：B 运行中快照周期抖动 + A 终态残留，两棵树稳定同显不横跳", () => {
  // 旧实现下此场景输出 runA/runB 交替（实验测得 9 次切换）；多树下两棵树恒在
  for (let tick = 13; tick < 30; tick++) {
    const files = byTimeDesc([
      // A 终态残留（cleanup 未删掉的存量）
      makeSnapshot({ runId: "runA", status: "completed", time: 10_000 }),
      // B 活快照，每 4 tick 抖动一次（模拟读失败瞬间）
      ...(tick % 4 !== 0 ? [makeSnapshot({ runId: "runB", status: "running", time: tick * 1000 })] : []),
    ])
    const list = pickAllProgresses(files, null, tick * 1000)
    const ids = list.map((p) => p.runId)
    // A 恒在；B 除抖动那一拍外恒在；不存在"A 顶替 B"或"B 顶替 A"的裁决
    assert.ok(ids.includes("runA"), `tick ${tick}: A 树应常驻`)
    if (tick % 4 !== 0) assert.ok(ids.includes("runB"), `tick ${tick}: B 树应常驻`)
  }
})

test("回归：双活心跳交错（后台 run 完成后回传窗口），两树同显互不顶替", () => {
  for (let tick = 0; tick < 21; tick++) {
    const files = byTimeDesc([
      // A 每 3s 心跳（模拟回传窗口内仍在刷新）
      ...(tick % 3 === 0 ? [makeSnapshot({ runId: "runA", status: "running", time: tick * 1000 })] : []),
      // B 每 3s 心跳，相位错开 1s
      ...((tick - 1) % 3 === 0 ? [makeSnapshot({ runId: "runB", status: "running", time: tick * 1000 })] : []),
    ])
    const list = pickAllProgresses(files, null, tick * 1000)
    // 无论心跳谁最后写，两个 run 的树都同时存在（旧实现 snapshots[0] 在两 run 间摆动）
    const ids = list.map((p) => p.runId)
    if (tick % 3 === 0) assert.ok(ids.includes("runA"), `tick ${tick}: A 树应在`)
    if ((tick - 1) % 3 === 0) assert.ok(ids.includes("runB"), `tick ${tick}: B 树应在`)
  }
})

test("多树 viewKey：任一树内容或树数量变化才变", () => {
  const a = makeSnapshot({ runId: "r1", status: "running", time: 1 })
  const b = makeSnapshot({ runId: "r2", status: "completed", time: 2 })
  const p = (s: RunSnapshotView) => pickAllProgresses([s], null, 10_000)[0]
  assert.equal(progressesViewKey([p(a), p(b)]), progressesViewKey([p(a), p(b)]))
  assert.notEqual(progressesViewKey([p(a), p(b)]), progressesViewKey([p(a)]))
  assert.equal(progressesViewKey([]), "none")
})

test("排序：心跳交错不互换，始终按 run 创建时间降序（新在上旧在下）", () => {
  // 创建时间：old 早于 mid 早于 new（runId 内嵌 base36 时间戳，后台格式带序号后缀）
  const t = Date.now() - 60_000
  const old = `run-${(t).toString(36)}`
  const mid = `run-${(t + 10_000).toString(36)}-2`
  const neo = `run-${(t + 20_000).toString(36)}`
  for (let heartbeat = 0; heartbeat < 6; heartbeat++) {
    // 心跳交错：每拍最后一个写 time 的 run 不同，入参 time 顺序交替
    const flip = heartbeat % 2 === 0
    const files = [
      makeSnapshot({ runId: old, status: "running", time: (heartbeat * 3 + (flip ? 3 : 0)) * 1000 }),
      makeSnapshot({ runId: mid, status: "running", time: (heartbeat * 3 + (flip ? 0 : 3)) * 1000 }),
      makeSnapshot({ runId: neo, status: "running", time: heartbeat * 1000 }),
    ].sort((a, b) => b.time - a.time)
    const list = pickAllProgresses(files, null, heartbeat * 1000 + 1000)
    assert.deepEqual(list.map((p) => p.runId), [neo, mid, old], `心跳第 ${heartbeat} 拍顺序应稳定`)
  }
  assert.ok(runCreatedAt(neo) > runCreatedAt(old))
})

test("buildMultiRunRows：每树插入 run 标题行，跨树节点复合键唯一", () => {
  const progress = (runId: string, nodeId: string): WorkflowProgress => ({
    runId,
    name: runId,
    status: "running",
    phases: ["P"],
    nodes: [{ id: nodeId, label: "l", phase: "P", status: "running" }],
    running: 1,
    completed: 0,
    failed: 0,
    total: 1,
  })
  const rows = buildMultiRunRows([progress("run1", "n0"), progress("run2", "n0")])
  // 两棵树：2 个 run 标题行 + 2 个 phase 行 + 2 个节点行
  assert.equal(rows.filter((r) => r.kind === "run").length, 2)
  assert.equal(rows.filter((r) => r.kind === "node").length, 2)
  // 节点 id 同为 n0，复合键必须不同
  const keys = selectableNodeKeys(rows)
  assert.equal(new Set(keys).size, 2)
  assert.deepEqual(keys, [selectionKey("run1", "n0"), selectionKey("run2", "n0")])
  // 按键反查节点命中正确 run 的节点
  const hit = findSelectedNode([progress("run1", "n0"), progress("run2", "n0")], selectionKey("run2", "n0"))
  assert.ok(hit)
  assert.equal(hit.id, "n0")
  assert.equal(findSelectedNode([progress("run1", "n0")], selectionKey("run2", "n0")), undefined)
})

test("B2 层级行：嵌套子 run 挂在触发节点后带 depth 缩进，孤儿提升为顶层", () => {
  // 三层链模拟：root(parent=主会话，节点带 sessionId) -> middle -> leaf x2，另有孤儿 run
  const p = (runId: string, parentSessionId: string | undefined, sessionIds: string[]) => ({
    runId,
    name: runId,
    status: "completed" as const,
    phases: ["P1"],
    nodes: sessionIds.map((sid, i) => ({ id: `${runId}:${i}`, label: `n${i}`, status: "ok" as const, sessionId: sid })),
    running: 0,
    completed: sessionIds.length,
    failed: 0,
    total: sessionIds.length,
    parentSessionId,
  })
  const progresses = [
    p("root", "ses_main", ["ses_a", "ses_z"]),
    p("middle", "ses_a", ["ses_b", "ses_c", "ses_d"]),
    p("leaf2", "ses_c", ["ses_f"]),
    p("leaf1", "ses_b", ["ses_e"]),
    p("orphan", "ses_gone", ["ses_h"]),
  ]
  // 传入列表按创建时间降序（root 最旧在前无妨，层级装配只看归属）
  const rows = buildNestedRunRows(progresses, "ses_main")
  const summary = rows.map((r) => {
    const who = r.kind === "node" ? r.node.id : r.kind === "run" ? r.runId : r.title
    return `${r.kind}:${who}:d${r.depth ?? 0}`
  })
  assert.deepEqual(summary, [
    "run:root:d0",
    "node:root:0:d0",
    "run:middle:d1", // 子workflow:middle 节点(ses_a)之后插入 middle 块
    "node:middle:0:d1",
    "run:leaf1:d2", // middle 的 ses_b 节点之后插 leaf1
    "node:leaf1:0:d2",
    "node:middle:1:d1",
    "run:leaf2:d2", // middle 的 ses_c 节点之后插 leaf2
    "node:leaf2:0:d2",
    "node:middle:2:d1",
    "node:root:1:d0",
    "run:orphan:d0", // 父会话不可见（ses_gone 无节点）→ 提升顶层
    "node:orphan:0:d0",
  ])

  // 拆分函数：顶层归属与子 run 查询
  const { tops, childrenOf } = splitRunsByParent(progresses, "ses_main")
  assert.deepEqual(tops.map((t) => t.runId).sort(), ["orphan", "root"])
  assert.deepEqual(childrenOf("ses_a").map((c) => c.runId), ["middle"])
  assert.deepEqual(childrenOf("ses_b").map((c) => c.runId), ["leaf1"])
})

test("B2 层级行：无 parentSessionId 的旧数据退化为平铺（与 buildMultiRunRows 同序）", () => {
  const progresses = [
    { runId: "a", name: "a", status: "completed" as const, phases: [], nodes: [{ id: "a:0", label: "n", status: "ok" as const }], running: 0, completed: 1, failed: 0, total: 1 },
    { runId: "b", name: "b", status: "completed" as const, phases: [], nodes: [{ id: "b:0", label: "n", status: "ok" as const }], running: 0, completed: 1, failed: 0, total: 1 },
  ]
  const nested = buildNestedRunRows(progresses, "ses_main")
  const flat = buildMultiRunRows(progresses)
  assert.deepEqual(nested, flat)
})

test("B2：toProgress 携带 parentSessionId（快照 -> 渲染模型的层级信息透传）", () => {
  const snapshot: RunSnapshotView = {
    version: 1,
    runId: "run-n",
    parentSessionId: "ses_child",
    rootSessionId: "ses_main",
    name: "nested",
    status: "completed",
    time: 1,
    phases: [],
    nodes: [{ id: "run-n:0", label: "n", status: "ok", sessionId: "s" }],
    running: 0,
    completed: 1,
    failed: 0,
    total: 1,
  }
  const progress = toProgress(snapshot)
  assert.equal(progress.parentSessionId, "ses_child")
  const rows = buildNestedRunRows([snapshot && progress], "ses_child")
  assert.equal(rows[0].kind, "run", "parent 即当前会话时作为顶层渲染")
})
