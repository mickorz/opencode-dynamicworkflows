/**
 * P3-D 证据评估单元测试
 *
 * 验证 evidenceIntegrity 与 candidateConfidence 独立评估
 */

import test from "node:test"
import assert from "node:assert/strict"
import { assessIntegrity, assessConfidence, assessOverallIntegrity } from "../src/development/analyzer/evidence.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import type { AnalysisToolEvent, ScriptExtractionCandidate } from "../src/development/analyzer/types.js"

/** 构造 ScriptExtractionCandidate */
function makeCandidate(opts: {
  sourceTool?: "write" | "edit" | "bash"
  scriptContent?: string
  filePath?: string
  toolCallCompleted?: boolean
  observedExecutions?: number
  determinism?: "likely" | "unknown" | "unlikely"
}): ScriptExtractionCandidate {
  return {
    sourceTool: opts.sourceTool ?? "write",
    scriptContent: opts.scriptContent ?? "print('hello')",
    filePath: opts.filePath ?? "test.py",
    executionEvents: [],
    toolCallCompleted: opts.toolCallCompleted ?? true,
    observedExecutions: opts.observedExecutions ?? 1,
    determinism: opts.determinism ?? "likely",
  }
}

// ============================================================
// assessIntegrity 测试
// ============================================================

test("integrity: write content 完整 → complete", () => {
  const events = FIXTURES.scriptExtraction()
  const writeEvent = events.find((e) => e.tool === "write")!
  assert.equal(assessIntegrity(writeEvent), "complete")
})

test("integrity: bash command 完整 → complete", () => {
  const events = FIXTURES.scriptExtraction()
  const bashEvent = events.find((e) => e.tool === "bash")!
  assert.equal(assessIntegrity(bashEvent), "complete")
})

test("integrity: read filePath 完整 → complete", () => {
  const events = FIXTURES.repeatSameRead()
  assert.equal(assessIntegrity(events[0]), "complete")
})

test("integrity: input 为空 → missing", () => {
  const event: AnalysisToolEvent = {
    ...FIXTURES.repeatSameRead()[0],
    input: {},
  }
  assert.equal(assessIntegrity(event), "missing")
})

test("integrity: 核心字段缺失 → missing", () => {
  const event: AnalysisToolEvent = {
    ...FIXTURES.scriptExtraction()[0],
    tool: "write",
    input: { filePath: "test.py" }, // 缺 content
  }
  assert.equal(assessIntegrity(event), "missing")
})

test("integrity: edit 工具 → partial（片段非完整文件）", () => {
  const events = FIXTURES.editFragment()
  assert.equal(assessIntegrity(events[0]), "partial")
})

test("integrity: bash completed 但无 output → partial", () => {
  const event: AnalysisToolEvent = {
    ...FIXTURES.scriptExtraction()[1], // bash event
    output: undefined,
    status: "completed",
  }
  assert.equal(assessIntegrity(event), "partial")
})

// ============================================================
// assessConfidence 测试
// ============================================================

test("confidence: 脚本完整+工具调用完成+determinism=likely → high", () => {
  const candidate = makeCandidate({ determinism: "likely" })
  assert.equal(assessConfidence(candidate, "complete"), "high")
})

test("confidence: 脚本完整+工具调用完成+determinism=unknown → medium", () => {
  const candidate = makeCandidate({ determinism: "unknown" })
  assert.equal(assessConfidence(candidate, "complete"), "medium")
})

test("confidence: determinism=unlikely → low", () => {
  const candidate = makeCandidate({ determinism: "unlikely" })
  assert.equal(assessConfidence(candidate, "complete"), "low")
})

test("confidence: 工具调用未完成 → low", () => {
  const candidate = makeCandidate({ toolCallCompleted: false, determinism: "likely" })
  assert.equal(assessConfidence(candidate, "complete"), "low")
})

test("confidence: 脚本截断(missing) → low", () => {
  const candidate = makeCandidate({ determinism: "likely" })
  assert.equal(assessConfidence(candidate, "missing"), "low")
})

test("confidence: 脚本片段(partial)+determinism=likely → medium", () => {
  const candidate = makeCandidate({ determinism: "likely" })
  assert.equal(assessConfidence(candidate, "partial"), "medium")
})

// ============================================================
// assessOverallIntegrity 测试
// ============================================================

test("overallIntegrity: 全部 complete → complete", () => {
  const events = FIXTURES.scriptExtraction()
  assert.equal(assessOverallIntegrity(events), "complete")
})

test("overallIntegrity: 有 missing → missing", () => {
  const events: AnalysisToolEvent[] = [
    ...FIXTURES.scriptExtraction(),
    { ...FIXTURES.scriptExtraction()[0], input: {} },
  ]
  assert.equal(assessOverallIntegrity(events), "missing")
})

test("overallIntegrity: 有 partial 但无 missing → partial", () => {
  const events: AnalysisToolEvent[] = [
    ...FIXTURES.scriptExtraction(),
    ...FIXTURES.editFragment(),
  ]
  assert.equal(assessOverallIntegrity(events), "partial")
})

test("overallIntegrity: 空事件列表 → missing", () => {
  assert.equal(assessOverallIntegrity([]), "missing")
})
