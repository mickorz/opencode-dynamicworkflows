/**
 * TUI 侧 run-snapshot-reader 与通道合并规则测试（F-20 实时通道）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRunSnapshot, tryWriteRunSnapshot } from "../src/tools/run-snapshot.js"
import {
  RUN_SNAPSHOT_STALE_MS,
  isStale,
  listSessionSnapshots,
  parseRunSnapshot,
  toProgress,
  type RunSnapshotView,
} from "../src/tui/run-snapshot-reader.js"
import { pickBestProgress, progressViewKey, type WorkflowProgress } from "../src/tui/workflow-store.js"

function snapshotView(overrides: Partial<RunSnapshotView> & { runId: string }): RunSnapshotView {
  return {
    version: 1,
    parentSessionId: "ses_p",
    name: "demo",
    status: "running",
    time: 1000,
    phases: ["P1"],
    nodes: [
      { id: "a:0", label: "n0", phase: "P1", status: "ok" },
      { id: "a:1", label: "n1", phase: "P1", status: "running", sessionId: "c1" },
    ],
    running: 1,
    completed: 1,
    failed: 0,
    total: 2,
    ...overrides,
  }
}

test("parseRunSnapshot：server 产物 roundtrip 解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-reader-"))
  try {
    tryWriteRunSnapshot(
      dir,
      buildRunSnapshot({
        runId: "run-x",
        parentSessionId: "ses_p",
        name: "demo",
        status: "running",
        records: [
          { id: "run-x:0", label: "config", phase: "Analyze", status: "ok", sessionId: "s1", durationMs: 1200 },
          { id: "run-x:1", label: "汇总", phase: "Summarize", status: "running", sessionId: "s2" },
        ],
        time: 42,
      }),
    )
    const views = listSessionSnapshots(dir, "ses_p")
    assert.equal(views.length, 1)
    const view = views[0]
    assert.equal(view.runId, "run-x")
    assert.equal(view.name, "demo")
    assert.equal(view.total, 2)
    assert.equal(view.completed, 1)
    assert.deepEqual(view.phases, ["Analyze", "Summarize"])
    assert.equal(view.nodes[1].sessionId, "s2")
    // 非 本会话 的快照被过滤
    assert.equal(listSessionSnapshots(dir, "ses_other").length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseRunSnapshot：非法形状返回 null（version 不符 与 缺字段 与 空节点）", () => {
  assert.equal(parseRunSnapshot(null), null)
  assert.equal(parseRunSnapshot({ version: 999, runId: "x", parentSessionId: "s", time: 1, agents: [] }), null)
  assert.equal(parseRunSnapshot({ version: 1, parentSessionId: "s", time: 1, agents: [] }), null) // 缺 runId
  assert.equal(parseRunSnapshot({ version: 1, runId: "x", parentSessionId: "s", time: 1, agents: "no" }), null)
  assert.equal(parseRunSnapshot({ version: 1, runId: "x", parentSessionId: "s", time: 1, agents: [{ bad: 1 }] }), null)
  assert.equal(parseRunSnapshot({ version: 1, runId: "x", parentSessionId: "s", time: 1, agents: [] }), null)
})

test("parseRunSnapshot：name 缺省回退 与 status 非法回退 running", () => {
  const view = parseRunSnapshot({
    version: 1,
    runId: "x",
    parentSessionId: "s",
    time: 1,
    status: "weird",
    agents: [{ id: "x:0", label: "l", status: "ok" }],
  })
  assert.ok(view)
  assert.equal(view.name, "workflow")
  assert.equal(view.status, "running")
})

test("isStale：仅 running 态需要心跳，终态永不失联", () => {
  const now = 100_000
  assert.equal(isStale(snapshotView({ runId: "a", status: "running", time: now - (RUN_SNAPSHOT_STALE_MS + 1) }), now), true)
  assert.equal(isStale(snapshotView({ runId: "b", status: "running", time: now - 1000 }), now), false)
  assert.equal(isStale(snapshotView({ runId: "c", status: "completed", time: 1 }), now), false)
})

test("toProgress：字段映射完整", () => {
  const p = toProgress(snapshotView({ runId: "r", name: "demo" }))
  assert.equal(p.runId, "r")
  assert.equal(p.nodes.length, 2)
  assert.equal(p.running, 1)
})

test("pickBestProgress：新鲜镜像优先（B 大于 C）", () => {
  const meta: WorkflowProgress = {
    runId: "old",
    name: "workflow",
    status: "completed",
    phases: [],
    nodes: [{ id: "m:0", label: "m", status: "ok" }],
    running: 0,
    completed: 1,
    failed: 0,
    total: 1,
  }
  const best = pickBestProgress([snapshotView({ runId: "new", time: 9999 })], meta, 10_000)
  assert.ok(best)
  assert.equal(best.runId, "new")
  assert.equal(best.status, "running")
})

test("pickBestProgress：running 快照失联降级 C 通道", () => {
  const stale = [snapshotView({ runId: "dead", status: "running", time: 0 })]
  const best = pickBestProgress(stale, null, RUN_SNAPSHOT_STALE_MS + 1)
  assert.equal(best, null)
  // C 通道有值则用 C
  const meta = { runId: "m" } as WorkflowProgress
  assert.equal(pickBestProgress(stale, meta, RUN_SNAPSHOT_STALE_MS + 1), meta)
})

test("pickBestProgress：终态快照永不失联（后台完成后常驻显示）", () => {
  const terminal = [snapshotView({ runId: "done", status: "completed", time: 0 })]
  const best = pickBestProgress(terminal, null, 10 ** 9)
  assert.ok(best)
  assert.equal(best.runId, "done")
})

test("pickBestProgress：多活后台 run 取 time 最新", () => {
  const snaps = [
    snapshotView({ runId: "newer", time: 3000 }),
    snapshotView({ runId: "older", time: 1000 }),
  ]
  const best = pickBestProgress(snaps, null, 3500)
  assert.equal(best?.runId, "newer")
})

test("progressViewKey：关键字段变化才变，未变则相等", () => {
  const a = snapshotView({ runId: "r", status: "running", running: 1, completed: 1 })
  const same = snapshotView({ runId: "r", status: "running", running: 1, completed: 1 })
  assert.equal(progressViewKey(toProgress(a)), progressViewKey(toProgress(same)))
  const changed = snapshotView({ runId: "r", status: "running", running: 0, completed: 2, total: 2 })
  assert.notEqual(progressViewKey(toProgress(a)), progressViewKey(toProgress(changed)))
  assert.equal(progressViewKey(null), "none")
})
