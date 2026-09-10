/**
 * TUI journal reader 测试（Node Inspector FR-6）
 *
 * 重点：server JournalStore 写 -> TUI parseJournalFile 读 的 roundtrip
 * （跨进程结构契约：TUI 侧禁止 import server 类型，用测试锁死两侧形状一致），
 * 以及对老格式 / 坏文件 / 非法 runId 的宽松解析。
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { JournalStore } from "../src/persistence/journal.js"
import { parseJournalFile, readJournalRaw } from "../src/tui/journal-reader.js"

test("roundtrip：server 写入的扩展 entry 由 TUI 读出且字段一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-jr-roundtrip-"))
  try {
    const store = new JournalStore(dir)
    store.append("run-a", "run-a:0", {
      hash: "h0",
      result: { ok: true, summary: "结论" },
      model: "p/m",
      label: "节点A",
      phase: "分析",
      agentType: "general",
      prompt: "读取 opencode.json",
      sessionId: "sess-1",
      outputType: "structured",
      executionId: "run-a:0:1",
      attempt: 1,
      startedAt: 1000,
      durationMs: 2500,
      usage: { inputTokens: 30, outputTokens: 20 },
    })
    store.recordExecution("run-a", "run-a:0", {
      executionId: "run-a:0:1",
      attempt: 1,
      status: "failed",
      error: "第一次失败",
    })

    const raw = readJournalRaw(dir, "run-a")
    assert.ok(raw, "journal 文件可读")
    const entries = parseJournalFile(raw!)
    assert.ok(entries)
    const entry = entries!.get("run-a:0")!
    assert.equal(entry.hash, "h0")
    assert.deepEqual(entry.result, { ok: true, summary: "结论" })
    assert.equal(entry.model, "p/m")
    assert.equal(entry.label, "节点A")
    assert.equal(entry.phase, "分析")
    assert.equal(entry.agentType, "general")
    assert.equal(entry.prompt, "读取 opencode.json")
    assert.equal(entry.sessionId, "sess-1")
    assert.equal(entry.outputType, "structured")
    assert.equal(entry.executionId, "run-a:0:1")
    assert.equal(entry.attempt, 1)
    assert.deepEqual(entry.usage, { inputTokens: 30, outputTokens: 20 })
    assert.equal(entry.executions?.length, 1)
    assert.equal(entry.executions?.[0].status, "failed")
    assert.equal(entry.executions?.[0].error, "第一次失败")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("老格式 journal（仅 hash/result/model）解析成功且新字段为 undefined", () => {
  const raw = JSON.stringify({
    version: 1,
    runId: "run-old",
    entries: { "run-old:0": { hash: "h", result: "文本结果", model: "p/m" } },
  })
  const entries = parseJournalFile(raw)!
  assert.equal(entries.size, 1)
  const entry = entries.get("run-old:0")!
  assert.equal(entry.result, "文本结果")
  assert.equal(entry.label, undefined)
  assert.equal(entry.executionId, undefined)
  assert.equal(entry.outputType, undefined)
  assert.equal(entry.executions, undefined)
})

test("坏 JSON / 缺 entries / 非 object 条目：宽松返回不抛错", () => {
  // 半截 JSON（跨进程读竞态）
  assert.equal(parseJournalFile('{"version":1,"entries":{"k":{"hash'), null)
  // 缺 entries
  assert.equal(parseJournalFile('{"version":1,"runId":"r"}'), null)
  // 非 JSON
  assert.equal(parseJournalFile("not json at all"), null)
  // 条目异构：坏条目跳过，好条目保留
  const mixed = JSON.stringify({
    version: 1,
    entries: { bad: 42, good: { hash: "h", result: 1 } },
  })
  const entries = parseJournalFile(mixed)!
  assert.equal(entries.size, 1)
  assert.ok(entries.has("good"))
})

test("readJournalRaw：文件不存在返回 null；非法 runId 防路径穿越", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-jr-safety-"))
  try {
    assert.equal(readJournalRaw(dir, "run-not-exist"), null)
    // 非法 runId（含路径分隔/点）直接拒绝，不触碰文件系统
    assert.equal(readJournalRaw(dir, "../evil"), null)
    assert.equal(readJournalRaw(dir, "a/b"), null)
    assert.equal(readJournalRaw(dir, ""), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
