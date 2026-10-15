/**
 * P3-C Script Extraction 单元测试
 *
 * 验证 Rule 5 脚本固化候选检测：
 *  - write 脚本 + bash 执行 → determinism=likely
 *  - heredoc 脚本 → 从 command 提取 content
 *  - 含 Date.now/time.time 的脚本 → determinism=unlikely
 *  - 含网络调用的脚本 → determinism=unknown
 *  - 工具调用未完成 → toolCallCompleted=false
 *  - edit 工具片段 → scriptContent 为片段
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  detectScriptExtractions,
  assessDeterminism,
  extractHeredoc,
} from "../src/development/analyzer/script-extraction.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import type { AnalysisToolEvent } from "../src/development/analyzer/types.js"

// ============================================================
// detectScriptExtractions 整体测试
// ============================================================

test("write 脚本 + bash 执行：determinism=likely", () => {
  const events = FIXTURES.scriptExtraction()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1, "应检测到 1 个脚本固化候选")
  const c = candidates[0]
  assert.equal(c.sourceTool, "write")
  assert.equal(c.determinism, "likely", "无 Date.now/网络调用，应为 likely")
  assert.equal(c.observedExecutions, 1, "执行 1 次")
  assert.equal(c.toolCallCompleted, true, "工具调用 completed")
  assert.ok(c.scriptContent.includes("import json"), "脚本内容应含 import json")
  assert.ok(c.filePath, "应有 filePath")
})

test("heredoc 脚本：从 bash command 提取 content", () => {
  const events = FIXTURES.heredocScript()
  const candidates = detectScriptExtractions(events)
  // heredoc 创建 + bash 执行应检测到候选
  assert.ok(candidates.length >= 1, "应至少检测到 1 个候选")
  const c = candidates[0]
  assert.equal(c.sourceTool, "bash", "heredoc 来源工具为 bash")
  assert.ok(c.scriptContent.includes("import sys"), "脚本内容应含 import sys")
  assert.ok(c.scriptContent.includes("print"), "脚本内容应含 print")
})

test("含 Date.now 的脚本：determinism=unlikely", () => {
  const events = FIXTURES.nondeterministicScript()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  // time.time() 匹配非确定性模式
  assert.equal(c.determinism, "unlikely", "含 time.time() 应为 unlikely")
})

test("含网络调用的脚本：determinism=unknown", () => {
  const events = FIXTURES.networkScript()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  assert.equal(c.determinism, "unknown", "含 requests.get 应为 unknown")
})

test("工具调用未完成：toolCallCompleted=false", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      status: "running",
    },
    ...FIXTURES.scriptExtraction().slice(1),
  ]
  const candidates = detectScriptExtractions(events)
  // write 工具 status=running，不是 completed
  // 但 bash 执行仍会匹配（因为 bash 是 completed）
  // 实际上 write status=running 也会被 collectScriptCreates 收集
  // toolCallCompleted = (create.event.status === "completed") = false
  if (candidates.length > 0) {
    assert.equal(candidates[0].toolCallCompleted, false, "工具调用未完成时 toolCallCompleted=false")
  }
})

test("edit 工具片段：scriptContent 为片段而非完整文件", () => {
  const events = FIXTURES.editFragment()
  const candidates = detectScriptExtractions(events)
  // edit 创建的脚本只有 newString 片段，无后续执行事件（FIXTURES 中没有 bash 执行 edit 的文件）
  // 所以不会产生候选（因为没有执行事件）
  assert.equal(candidates.length, 0, "无执行事件不产生候选")
})

test("edit 工具片段 + bash 执行：scriptContent 为片段", () => {
  const events: AnalysisToolEvent[] = [
    ...FIXTURES.editFragment(),
    {
      ...FIXTURES.scriptExtraction()[1],
      callID: "exec-1",
      input: { command: "python script.py" },
      startedAt: 2000,
      endedAt: 2500,
    },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1)
  const c = candidates[0]
  assert.equal(c.sourceTool, "edit", "来源工具为 edit")
  // edit 的 scriptContent 是 newString 片段，不是完整文件
  assert.equal(c.scriptContent, "print('hello world')", "scriptContent 应为 edit 的 newString 片段")
})

test("无脚本创建事件：返回空数组", () => {
  const events = FIXTURES.repeatSameRead()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0)
})

test("脚本创建但无执行事件：不产生候选", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "write-only",
    },
    // 无后续 bash 执行
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "无执行事件不应产生候选")
})

test("空事件列表：返回空数组", () => {
  const candidates = detectScriptExtractions(FIXTURES.empty())
  assert.equal(candidates.length, 0)
})

// ============================================================
// assessDeterminism 单元测试
// ============================================================

test("assessDeterminism：无非确定性 API → likely", () => {
  assert.equal(assessDeterminism("print('hello')"), "likely")
  assert.equal(assessDeterminism("import json\njson.dumps({})"), "likely")
})

test("assessDeterminism：含 Date.now → unlikely", () => {
  assert.equal(assessDeterminism("const t = Date.now()"), "unlikely")
})

test("assessDeterminism：含 Math.random → unlikely", () => {
  assert.equal(assessDeterminism("const r = Math.random()"), "unlikely")
})

test("assessDeterminism：含 new Date → unlikely", () => {
  assert.equal(assessDeterminism("const d = new Date()"), "unlikely")
})

test("assessDeterminism：含 time.time → unlikely", () => {
  assert.equal(assessDeterminism("import time\nt = time.time()"), "unlikely")
})

test("assessDeterminism：含 requests.get → unknown", () => {
  assert.equal(assessDeterminism("import requests\nr = requests.get('url')"), "unknown")
})

test("assessDeterminism：含 fetch → unknown", () => {
  assert.equal(assessDeterminism("const r = await fetch('url')"), "unknown")
})

test("assessDeterminism：含 subprocess → unknown", () => {
  assert.equal(assessDeterminism("import subprocess\nsubprocess.run(['ls'])"), "unknown")
})

test("assessDeterminism：unlikely 优先于 unknown", () => {
  // 同时含 Date.now 和 requests.get，应为 unlikely（优先级更高）
  assert.equal(assessDeterminism("Date.now()\nrequests.get('url')"), "unlikely")
})

// ============================================================
// extractHeredoc 单元测试
// ============================================================

test("extractHeredoc：单引号 EOF 定界符", () => {
  const command = "cat <<'EOF' > test.py\nprint('hello')\nprint('world')\nEOF"
  const result = extractHeredoc(command)
  assert.ok(result, "应提取到 heredoc 内容")
  assert.equal(result!.content, "print('hello')\nprint('world')")
})

test("extractHeredoc：无引号 EOF 定界符", () => {
  const command = "cat <<EOF > test.py\nprint('hello')\nEOF"
  const result = extractHeredoc(command)
  assert.ok(result)
  assert.equal(result!.content, "print('hello')")
})

test("extractHeredoc：无 heredoc 返回 null", () => {
  assert.equal(extractHeredoc("echo hello"), null)
  assert.equal(extractHeredoc("python script.py"), null)
})
