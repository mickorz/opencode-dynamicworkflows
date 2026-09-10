/**
 * ResultView 测试（Node Inspector FR-4/FR-5：空态三分、pretty-print、20KB 截断、脱敏）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  formatResultBody,
  resolveResultState,
  RESULT_MAX_BYTES,
} from "../src/tui/result-view.js"
import type { JournalEntryView } from "../src/tui/journal-reader.js"

test("formatResultBody：text 原样、structured pretty-print、raw 退化", () => {
  const text = formatResultBody("一段纯文本", "text")
  assert.equal(text.kind, "text")
  assert.equal(text.body, "一段纯文本")
  assert.equal(text.truncated, false)

  const structured = formatResultBody({ ok: true, items: [1, 2] }, "structured")
  assert.equal(structured.kind, "structured")
  assert.equal(structured.body, '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}')

  // outputType=text 但值不是 string：退化 raw
  const raw = formatResultBody(12345, "text")
  assert.equal(raw.kind, "raw")
  assert.equal(raw.body, "12345")

  // 老 journal 无 outputType、值为 string：推断为 text 分支
  const inferred = formatResultBody("老格式字符串", "unknown")
  // unknown 类型走 structured 分支渲染（typeof string 仍会 pretty-print 带引号）
  assert.equal(inferred.kind, "structured")
})

test("formatResultBody：超 20KB 截断并带原始体积", () => {
  const big = "字".repeat(10_000) // 30KB
  const view = formatResultBody(big, "text")
  assert.equal(view.truncated, true)
  assert.equal(view.originalBytes, Buffer.byteLength(big, "utf8"))
  assert.ok(Buffer.byteLength(view.body, "utf8") <= RESULT_MAX_BYTES)
  assert.ok(!view.body.includes("�"))
})

test("formatResultBody：structured 渲染前脱敏，敏感值不出现在正文", () => {
  const view = formatResultBody({ api_key: "sk-secret", safe: "保留" }, "structured")
  assert.ok(!view.body.includes("sk-secret"))
  assert.ok(view.body.includes("[REDACTED]"))
  assert.ok(view.body.includes("保留"))
})

test("resolveResultState：failed 优先显示 Error", () => {
  const state = resolveResultState({
    status: "failed",
    error: "timeout: 超过 20ms",
    entry: { result: "不应显示" },
    preview: "也不应显示",
  })
  assert.deepEqual(state, { state: "error", message: "timeout: 超过 20ms" })
})

test("resolveResultState：running 无结果显示 pending（No result yet）", () => {
  const state = resolveResultState({ status: "running", entry: null, preview: undefined })
  assert.deepEqual(state, { state: "pending" })
})

test("resolveResultState：completed 无结果显示 empty（含 schema 合法 null）", () => {
  // journal 未写入（节点刚完成、entry 尚不可见）
  const noEntry = resolveResultState({ status: "ok", entry: null, preview: undefined })
  assert.deepEqual(noEntry, { state: "empty" })
  // schema 路径 info.structured ?? null 的合法 null
  const nullResult = resolveResultState({ status: "ok", entry: { result: null }, preview: undefined })
  assert.deepEqual(nullResult, { state: "empty" })
  // aborted 无 error 无 result 同样归 empty（中止语义在 header 呈现）
  const aborted = resolveResultState({ status: "aborted", entry: null, preview: undefined })
  assert.deepEqual(aborted, { state: "empty" })
})

test("resolveResultState：journal 有 result 显示 content(journal)", () => {
  const entry: JournalEntryView = { result: { ok: true }, outputType: "structured" }
  const state = resolveResultState({ status: "ok", entry, preview: undefined })
  assert.equal(state.state, "content")
  if (state.state === "content") {
    assert.equal(state.source, "journal")
    assert.equal(state.view.kind, "structured")
    assert.ok(state.view.body.includes("\"ok\": true"))
  }
})

test("resolveResultState：journal 无 result 但快照预览存在时兜底 content(preview)", () => {
  const state = resolveResultState({ status: "ok", entry: null, preview: "快照里的两KB预览" })
  assert.equal(state.state, "content")
  if (state.state === "content") {
    assert.equal(state.source, "preview")
    assert.equal(state.view.body, "快照里的两KB预览")
  }
})

test("resolveResultState：老 journal 无 outputType 时按值类型推断分支", () => {
  const stringEntry: JournalEntryView = { result: "老格式的文本结果" }
  const state = resolveResultState({ status: "ok", entry: stringEntry, preview: undefined })
  assert.equal(state.state, "content")
  if (state.state === "content") {
    assert.equal(state.view.kind, "text")
    assert.equal(state.view.body, "老格式的文本结果")
  }
})
