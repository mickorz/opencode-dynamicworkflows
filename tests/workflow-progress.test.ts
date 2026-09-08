/**
 * workflow-progress 序列化测试（F-20 MVP-1 前台通道 server 侧）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { buildProgressMetadata, derivePhases } from "../src/tools/workflow-progress.js"
import type { AgentRecord } from "../src/types/index.js"

function record(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return { label: `label-${overrides.id}`, status: "ok", ...overrides }
}

test("derivePhases 按首次出现顺序收集，去重且跳过空 phase", () => {
  const phases = derivePhases([
    record({ id: "a", phase: "Analyze" }),
    record({ id: "b", phase: "Analyze" }),
    record({ id: "c" }),
    record({ id: "d", phase: "Summarize" }),
    record({ id: "e", phase: "Analyze" }),
  ])
  assert.deepEqual(phases, ["Analyze", "Summarize"])
})

test("buildProgressMetadata 计数与字段形状（TUI 侧读取的契约）", () => {
  const records = [
    record({ id: "r:0", phase: "P1", status: "ok", sessionId: "sess-1", durationMs: 1200 }),
    record({ id: "r:1", phase: "P1", status: "running", sessionId: "sess-2" }),
    record({ id: "r:2", phase: "P2", status: "failed", error: "boom" }),
    record({ id: "r:3", status: "aborted" }),
  ]
  const meta = buildProgressMetadata({ runId: "r", name: "demo", status: "running", records })
  assert.equal(meta.runId, "r")
  assert.equal(meta.name, "demo")
  assert.equal(meta.status, "running")
  assert.deepEqual(meta.phases, ["P1", "P2"])
  assert.equal(meta.agents, records)
  assert.equal(meta.completed, 1)
  assert.equal(meta.running, 1)
  assert.equal(meta.failed, 1)
  assert.equal(meta.total, 4)
  // running 态节点就带 sessionId（TUI 可中途进子会话）
  assert.equal(meta.agents[1].sessionId, "sess-2")
})

test("buildProgressMetadata 无 name 时省略字段而非空串", () => {
  const meta = buildProgressMetadata({
    runId: "r",
    status: "completed",
    records: [record({ id: "r:0" })],
  })
  assert.ok(!("name" in meta))
})

test("终态枚举完整（completed/aborted/failed/running）", () => {
  for (const status of ["running", "completed", "aborted", "failed"] as const) {
    const meta = buildProgressMetadata({ runId: "r", status, records: [] })
    assert.equal(meta.status, status)
  }
})
