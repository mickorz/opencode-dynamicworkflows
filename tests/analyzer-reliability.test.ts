/**
 * P3.1 可靠性加固验证测试
 *
 * P0-1: EvidenceRef 使用真实 sessionId/callID/ts
 * P0-2: findExecutionEvents 区分执行与提及
 * P0-3: readToolOutput ESM 兼容（静态 import）
 * P1-4: stableStringify 键转义 + undefined 处理
 * P1-5: Resume 场景 runAttemptId 独立去重
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectScriptExtractions } from "../src/development/analyzer/script-extraction.js"
import { buildProposals } from "../src/development/analyzer/report-builder.js"
import { stableStringify } from "../src/development/analyzer/rules.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import { DevJobManager } from "../src/development/job-manager.js"
import type { BackgroundRunManager } from "../src/tools/background-runs.js"
import type { BackgroundStartDeps, BackgroundStartInput } from "../src/tools/background-runs.js"
import type { RuleResults, AnalysisToolEvent } from "../src/development/analyzer/types.js"
import { detectRepeats, detectRetries, detectDependencies, analyzeLatency } from "../src/development/analyzer/rules.js"
import { assessOverallIntegrity } from "../src/development/analyzer/evidence.js"
import { buildReport } from "../src/development/analyzer/report-builder.js"
import type { AnalysisResult } from "../src/development/analyzer/types.js"

// ============================================================
// P0-1: EvidenceRef 使用真实 sessionId/callID/ts
// ============================================================

test("P0-1: EvidenceRef 创建事件引用含真实 sessionId/callID/ts", () => {
  const events = FIXTURES.scriptExtraction()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1)

  const candidate = candidates[0]
  // createEvent 应有真实数据
  assert.ok(candidate.createEvent, "createEvent 不应为空")
  assert.ok(candidate.createEvent.callID, "createEvent.callID 不应为空")
  assert.ok(candidate.createEvent.sessionId, "createEvent.sessionId 不应为空")
  assert.ok(candidate.createEvent.startedAt, "createEvent.startedAt 不应为空")

  // 生成 Proposal 后检查 evidenceRefs
  const ruleResults: RuleResults = {
    repeats: [],
    retries: [],
    dependencies: [],
    latency: { agents: [], totalMs: 0 },
    scriptExtractions: candidates,
  }
  const proposals = buildProposals("run-test", "run-test:abc", ruleResults, events)
  assert.equal(proposals.length, 1)

  const refs = proposals[0].evidenceRefs
  // 第一个 ref 是创建事件
  const createRef = refs[0]
  assert.ok(createRef.sessionId, "创建事件 ref 的 sessionId 不应为空字符串")
  assert.ok(createRef.callID, "创建事件 ref 的 callID 不应为空字符串")
  assert.ok(createRef.ts > 0, "创建事件 ref 的 ts 应大于 0")
  assert.ok(createRef.agentLabel, "创建事件 ref 的 agentLabel 不应为空字符串")

  // 可以追溯到原始事件
  const sourceEvent = events.find((e) => e.callID === createRef.callID)
  assert.ok(sourceEvent, `EvidenceRef callID=${createRef.callID} 应能在原始事件中找到对应 ToolCallEvent`)
  assert.equal(sourceEvent!.sessionId, createRef.sessionId)
})

test("P0-1: EvidenceRef 执行事件引用含真实 sessionId/callID/ts", () => {
  const events = FIXTURES.scriptExtraction()
  const candidates = detectScriptExtractions(events)
  const candidate = candidates[0]

  // executionEvents 的 ref 应有真实数据
  const ruleResults: RuleResults = {
    repeats: [],
    retries: [],
    dependencies: [],
    latency: { agents: [], totalMs: 0 },
    scriptExtractions: candidates,
  }
  const proposals = buildProposals("run-test", "run-test:abc", ruleResults, events)
  const refs = proposals[0].evidenceRefs

  // 找到执行事件的 ref（note 含"脚本执行"）
  const execRefs = refs.filter((r) => r.note.includes("脚本执行"))
  assert.ok(execRefs.length > 0, "应有执行事件 ref")
  for (const ref of execRefs) {
    assert.ok(ref.sessionId, "执行 ref 的 sessionId 不应为空")
    assert.ok(ref.callID, "执行 ref 的 callID 不应为空")
    assert.ok(ref.ts > 0, "执行 ref 的 ts 应大于 0")
  }
})

// ============================================================
// P0-2: findExecutionEvents 区分执行与提及
// ============================================================

test("P0-2: python script.py 算确认执行", () => {
  const events = FIXTURES.scriptExtraction()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1)
  assert.ok(candidates[0].executionEvents.length > 0, "python validate.py 应为确认执行")
  assert.equal(candidates[0].possibleExecutions.length, 0, "无可能提及")
})

test("P0-2: echo 'check script.py' 不算确认执行", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "create-1",
    },
    {
      ...FIXTURES.scriptExtraction()[1],
      callID: "mention-1",
      input: { command: 'echo "请检查 validate.py"' },
      startedAt: 2000,
      endedAt: 2100,
    },
  ]
  const candidates = detectScriptExtractions(events)
  // echo 不是执行形式，不产生候选
  assert.equal(candidates.length, 0, "echo 提及脚本不应产生 script extraction 候选")
})

test("P0-2: cat script.py 不算确认执行", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "create-1",
    },
    {
      ...FIXTURES.scriptExtraction()[1],
      callID: "cat-1",
      input: { command: "cat validate.py" },
      startedAt: 2000,
      endedAt: 2100,
    },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "cat 不是执行形式，不应产生候选")
})

test("P0-2: pending/running 状态的 bash 不算执行", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "create-1",
    },
    {
      ...FIXTURES.scriptExtraction()[1],
      callID: "exec-pending",
      status: "pending",
      startedAt: 2000,
      endedAt: 2100,
    },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "pending 状态的 bash 不算执行")
})

test("P0-2: error 状态的 bash 算执行（失败也算尝试过）", () => {
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "create-1",
    },
    {
      ...FIXTURES.scriptExtraction()[1],
      callID: "exec-error",
      status: "error",
      error: "syntax error",
      startedAt: 2000,
      endedAt: 2100,
    },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1, "error 状态的 bash 仍算执行（尝试过但失败）")
  assert.equal(candidates[0].executionEvents.length, 1)
  // toolCallCompleted 来自创建事件（write），不是执行事件
  assert.equal(candidates[0].toolCallCompleted, true, "创建事件 completed")
})

// ============================================================
// P1-4: stableStringify 键转义 + undefined 处理
// ============================================================

test("P1-4: stableStringify 含特殊字符的键正确转义", () => {
  const obj = { 'key"with"quotes': 1, "key\\backslash": 2 }
  const result = stableStringify(obj)
  // 应能被 JSON.parse 正确解析
  const parsed = JSON.parse(result)
  assert.equal(parsed['key"with"quotes'], 1)
  assert.equal(parsed["key\\backslash"], 2)
})

test("P1-4: stableStringify 跳过 undefined 值", () => {
  const obj = { a: 1, b: undefined, c: 3 }
  const result = stableStringify(obj)
  const parsed = JSON.parse(result)
  assert.equal(parsed.a, 1)
  assert.ok(!("b" in parsed), "undefined 值应被跳过")
  assert.equal(parsed.c, 3)
})

test("P1-4: stableStringify 跳过函数和 Symbol", () => {
  const sym = Symbol("test")
  const obj = { a: 1, fn: () => {}, [sym]: "value", c: 3 }
  const result = stableStringify(obj)
  const parsed = JSON.parse(result)
  assert.equal(parsed.a, 1)
  assert.ok(!("fn" in parsed), "函数应被跳过")
  assert.equal(parsed.c, 3)
})

test("P1-4: stableStringify 嵌套 undefined 正确处理", () => {
  const a = { x: { y: undefined, z: 1 } }
  const b = { x: { z: 1 } }
  // undefined 被跳过后，a 和 b 应序列化相同
  assert.equal(stableStringify(a), stableStringify(b))
})

test("P1-4: stableStringify 产出有效 JSON", () => {
  const obj = { a: 1, b: { c: "hello", d: [1, 2, 3] }, e: null }
  const result = stableStringify(obj)
  // 应能被 JSON.parse 正确解析（有效 JSON）
  assert.doesNotThrow(() => JSON.parse(result))
})

// ============================================================
// P1-5: Resume 场景 runAttemptId 独立去重
// ============================================================

/** Fake BackgroundRunManager */
function makeFakeBackground(): Pick<BackgroundRunManager, "start"> {
  let seq = 0
  return {
    start(_deps: BackgroundStartDeps, input: BackgroundStartInput): string {
      const runId = `run-opt-${++seq}`
      if (input.onFinished) {
        const onFinished = input.onFinished
        queueMicrotask(() => {
          onFinished({ runId, name: "optimizer", status: "completed", startedAt: Date.now(), records: [], composites: [], logs: [], delivered: false })
        })
      }
      return runId
    },
  }
}

/** 构造测试输入 */
function makeInput(dir: string, runId: string, runAttemptId?: string) {
  const historyDir = join(dir, ".opencode-workflows", "history", runId)
  mkdirSync(historyDir, { recursive: true })
  const manifest = {
    version: 1,
    runId,
    runAttemptId: runAttemptId ?? `${runId}:abc`,
    rootRunId: runId,
    startedAt: 1000,
    endedAt: 5000,
    status: "completed" as const,
    completeness: "full" as const,
    development: true,
    sessions: [{
      sessionId: "sess-test",
      agentId: `${runId}:0`,
      agentLabel: "Test Agent",
      eventCount: 2,
      replayed: false,
      outputIntegrity: "full" as const,
    }],
  }
  writeFileSync(join(historyDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  writeFileSync(join(historyDir, "history.jsonl"), '{"type":"agent_start"}\n', "utf8")
  return {
    runId,
    originRunId: runId,
    runAttemptId,
    directory: dir,
    historyPath: historyDir,
    client: {} as never,
    parentSessionId: "ses-parent",
    rootSessionId: "ses-root",
    agents: [] as never[],
  }
}

test("P1-5: 同一 runId 不同 runAttemptId 可独立创建 Job", () => {
  const dir = mkdtempSync(join(tmpdir(), "p31-resume-test-"))
  try {
    const fakeBg = makeFakeBackground()
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    // 第一轮执行
    const job1 = mgr.createOnce(makeInput(dir, "run-resume", "run-resume:attempt1"))
    assert.ok(job1)

    // Resume 后第二轮执行（同一 runId，不同 runAttemptId）
    const job2 = mgr.createOnce(makeInput(dir, "run-resume", "run-resume:attempt2"))
    assert.ok(job2)

    // 应创建两个独立 Job
    assert.notEqual(job1, job2, "不同 runAttemptId 应创建独立 Job")
    assert.equal(mgr.list().length, 2, "应有两个 Job")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P1-5: 同一 runId 同一 runAttemptId 幂等", () => {
  const dir = mkdtempSync(join(tmpdir(), "p31-idempotent-test-"))
  try {
    const fakeBg = makeFakeBackground()
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    const job1 = mgr.createOnce(makeInput(dir, "run-idem", "run-idem:attempt1"))
    const job2 = mgr.createOnce(makeInput(dir, "run-idem", "run-idem:attempt1"))

    assert.equal(job1, job2, "同一 runAttemptId 应返回同一 Job")
    assert.equal(mgr.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P1-5: 无 runAttemptId 时回退到 runId 去重", () => {
  const dir = mkdtempSync(join(tmpdir(), "p31-no-attempt-test-"))
  try {
    const fakeBg = makeFakeBackground()
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    const job1 = mgr.createOnce(makeInput(dir, "run-no-attempt", undefined))
    const job2 = mgr.createOnce(makeInput(dir, "run-no-attempt", undefined))

    assert.equal(job1, job2, "无 runAttemptId 时按 runId 去重")
    assert.equal(mgr.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
