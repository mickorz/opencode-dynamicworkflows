/**
 * run-snapshot 测试（F-20 实时通道 server 侧）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  RUN_SNAPSHOT_VERSION,
  buildRunSnapshot,
  cleanupRunSnapshots,
  readRunSnapshots,
  runSnapshotPath,
  tryWriteRunSnapshot,
} from "../src/tools/run-snapshot.js"
import type { AgentRecord } from "../src/types/index.js"

function record(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { label: `label-${overrides.id}`, status: "ok", ...overrides }
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "wf-snapshot-"))
}

test("buildRunSnapshot：字段完整、复用 progress 序列化、含镜像专有字段", () => {
  const records = [
    record({ id: "r:0", phase: "P1", status: "ok", sessionId: "s1", durationMs: 1000 }),
    record({ id: "r:1", phase: "P2", status: "running", sessionId: "s2" }),
  ]
  const snap = buildRunSnapshot({
    runId: "r",
    parentSessionId: "ses_parent",
    name: "demo",
    status: "running",
    records,
    time: 123456,
  })
  assert.equal(snap.version, RUN_SNAPSHOT_VERSION)
  assert.equal(snap.parentSessionId, "ses_parent")
  assert.equal(snap.time, 123456)
  assert.equal(snap.runId, "r")
  assert.equal(snap.status, "running")
  assert.deepEqual(snap.phases, ["P1", "P2"])
  assert.equal(snap.agents, records)
  assert.equal(snap.total, 2)
  assert.equal(snap.completed, 1)
  assert.equal(snap.running, 1)
})

test("writeRunSnapshot：目录自动创建、可覆盖写、roundtrip 读回", () => {
  const dir = tempProject()
  try {
    const base = { runId: "run-a", parentSessionId: "ses_p", name: "demo", records: [record({ id: "run-a:0" })] }
    tryWriteRunSnapshot(dir, buildRunSnapshot({ ...base, status: "running", time: 1000 }))
    assert.ok(existsSync(runSnapshotPath(dir, "run-a")))

    // 覆盖写（同一 runId 状态推进），Windows rename 覆盖路径被覆盖到
    tryWriteRunSnapshot(dir, buildRunSnapshot({ ...base, status: "completed", time: 2000 }))

    const snapshots = readRunSnapshots(dir, "ses_p")
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, "completed")
    assert.equal(snapshots[0].time, 2000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readRunSnapshots：过滤会话、跳过坏文件与版本不符、按 time 降序", () => {
  const dir = tempProject()
  try {
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "a", parentSessionId: "ses_p", status: "running", records: [], time: 1000 }))
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "b", parentSessionId: "ses_p", status: "running", records: [], time: 3000 }))
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "c", parentSessionId: "ses_other", status: "running", records: [], time: 2000 }))
    // 坏文件 + 版本不符文件
    writeFileSync(runSnapshotPath(dir, "bad"), "{not json", "utf8")
    writeFileSync(
      runSnapshotPath(dir, "oldver"),
      JSON.stringify({ version: 999, runId: "oldver", parentSessionId: "ses_p", time: 9999 }),
      "utf8",
    )

    const snapshots = readRunSnapshots(dir, "ses_p")
    assert.deepEqual(
      snapshots.map((s) => s.runId),
      ["b", "a"],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cleanupRunSnapshots：只删同会话的终态快照，活快照与他 会话快照保留", () => {
  const dir = tempProject()
  try {
    // 同会话：终态两个 + 活一个；他 会话终态一个
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "done1", parentSessionId: "ses_p", status: "completed", records: [], time: 1000 }))
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "done2", parentSessionId: "ses_p", status: "aborted", records: [], time: 2000 }))
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "alive", parentSessionId: "ses_p", status: "running", records: [], time: 3000 }))
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "other", parentSessionId: "ses_q", status: "completed", records: [], time: 4000 }))

    cleanupRunSnapshots(dir, "ses_p")

    const remaining = readRunSnapshots(dir, "ses_p").map((s) => s.runId).sort()
    assert.deepEqual(remaining, ["alive"])
    assert.equal(readRunSnapshots(dir, "ses_q").length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("写失败不抛错（只读目录降级）", () => {
  // 目录路径被一个同名文件占用 -> mkdir 失败 -> 静默降级
  const dir = tempProject()
  try {
    writeFileSync(join(dir, ".opencode-workflows"), "占位文件", "utf8")
    tryWriteRunSnapshot(dir, buildRunSnapshot({ runId: "x", parentSessionId: "s", status: "running", records: [], time: 1 }))
    // 不抛错即通过
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("快照 JSON 可被 TUI 侧宽松解析（跨进程形状契约：无 undefined 字段残留）", () => {
  const dir = tempProject()
  try {
    tryWriteRunSnapshot(
      dir,
      buildRunSnapshot({ runId: "k", parentSessionId: "s", status: "running", records: [record({ id: "k:0", sessionId: "c1" })], time: 1 }),
    )
    const raw = readFileSync(runSnapshotPath(dir, "k"), "utf8")
    assert.doesNotMatch(raw, /undefined/, "JSON 序列化不应含 undefined 字面量")
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.agents[0].sessionId, "c1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
