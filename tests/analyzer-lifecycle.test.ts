/**
 * P3.2 生命周期测试
 *
 * 验收链路：
 *  1. 创建 Job → 后台完成 → 状态变为 completed
 *  2. 重启加载 → 幂等命中
 *  3. Resume 第二轮 → 不覆盖第一轮的 History
 *  4. readToolOutput 真实文件读取
 *  5. isConfirmedExecution 收紧验证（grep/rm/sed 不算执行）
 *  6. stableStringify 签名稳定性（嵌套数组 + 特殊字符键）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevJobManager, makeJobKey } from "../src/development/job-manager.js"
import { TraceStore, sanitizeForPath } from "../src/trace/store.js"
import { stableStringify, signature } from "../src/development/analyzer/rules.js"
import { detectScriptExtractions } from "../src/development/analyzer/script-extraction.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import { OpenCodeSessionAdapter } from "../src/adapters/opencode-session-adapter.js"
import type { BackgroundRunManager } from "../src/tools/background-runs.js"
import type { BackgroundStartDeps, BackgroundStartInput } from "../src/tools/background-runs.js"
import type { AnalysisToolEvent } from "../src/development/analyzer/types.js"

/** Fake BackgroundRunManager：记录 start 调用，可控制 onFinished 时序 */
function makeFakeBackground(opts: {
  onStarted?: (input: BackgroundStartInput) => void
  delayFinish?: boolean
}): { bg: Pick<BackgroundRunManager, "start">; finishCallbacks: Array<() => void> } {
  const finishCallbacks: Array<() => void> = []
  let seq = 0
  return {
    bg: {
      start(_deps: BackgroundStartDeps, input: BackgroundStartInput): string {
        const runId = `run-opt-${++seq}`
        opts.onStarted?.(input)
        if (input.onFinished && !opts.delayFinish) {
          const onFinished = input.onFinished
          queueMicrotask(() => {
            onFinished({ runId, name: "optimizer", status: "completed", startedAt: Date.now(), records: [], composites: [], logs: [], delivered: false })
          })
        } else if (input.onFinished && opts.delayFinish) {
          const onFinished = input.onFinished
          finishCallbacks.push(() => {
            onFinished({ runId, name: "optimizer", status: "completed", startedAt: Date.now(), records: [], composites: [], logs: [], delivered: false })
          })
        }
        return runId
      },
    },
    finishCallbacks,
  }
}

/** 构造测试输入 */
function makeInput(dir: string, runId: string, runAttemptId: string) {
  const store = new TraceStore(dir)
  const attemptDir = store.runDir(runId, runAttemptId)
  mkdirSync(attemptDir, { recursive: true })
  const manifest = {
    version: 1, runId, runAttemptId, rootRunId: runId,
    startedAt: 1000, endedAt: 5000, status: "completed" as const,
    completeness: "full" as const, development: true,
    sessions: [{ sessionId: "sess-test", agentId: `${runId}:0`, agentLabel: "Agent", eventCount: 2, replayed: false, outputIntegrity: "full" as const }],
  }
  writeFileSync(join(attemptDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  writeFileSync(join(attemptDir, "history.jsonl"), '{"type":"agent_start"}\n', "utf8")
  return {
    runId, originRunId: runId, runAttemptId,
    directory: dir, historyPath: attemptDir,
    client: {} as never, parentSessionId: "ses-parent", rootSessionId: "ses-root",
    agents: [] as never[],
  }
}

// ============================================================
// 1. 完整生命周期：创建 → 完成 → 重启 → 幂等
// ============================================================

test("生命周期：创建 → 后台完成 → completed → 重启加载 → 幂等命中", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p32-lifecycle-"))
  try {
    const { bg } = makeFakeBackground({})
    const mgr = new DevJobManager(bg as BackgroundRunManager)

    // 1. 创建 Job
    const job = mgr.createOnce(makeInput(dir, "run-life", "run-life:att1"))
    assert.ok(job)
    assert.equal(job.status, "running", "创建后应为 running")

    // 2. 等待后台完成（queueMicrotask 异步）
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // 3. 状态应变为 completed
    const completedJob = mgr.list().find((j) => j.runId === "run-life")
    assert.ok(completedJob, "Job 应存在")
    assert.equal(completedJob!.status, "completed", "后台完成后应为 completed")

    // 4. 重启：用新 DevJobManager 加载
    const mgr2 = new DevJobManager(bg as BackgroundRunManager)
    mgr2.load(dir)

    // 5. 幂等命中：同一 runId+runAttemptId 返回已有 Job
    const existing = mgr2.createOnce(makeInput(dir, "run-life", "run-life:att1"))
    assert.ok(existing)
    assert.equal(existing!.status, "completed", "重启后幂等命中应返回已完成 Job")
    assert.equal(mgr2.list().length, 1, "不应创建重复 Job")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================
// 2. Resume 第二轮不覆盖第一轮的 History
// ============================================================

test("Resume 隔离：第二轮不覆盖第一轮的 manifest 和 history", () => {
  const dir = mkdtempSync(join(tmpdir(), "p32-resume-isolation-"))
  try {
    const store = new TraceStore(dir)
    const runId = "run-resume-test"
    const att1 = "run-resume-test:attempt1"
    const att2 = "run-resume-test:attempt2"

    // 第一轮写入
    const manifest1 = { version: 1, runId, runAttemptId: att1, rootRunId: runId, startedAt: 1000, endedAt: 2000, status: "completed" as const, completeness: "full" as const, sessions: [] }
    store.writeManifest(runId, manifest1 as never, att1)
    store.writeHistory(runId, '{"attempt":1}\n', att1)

    // 第二轮写入（同一 runId，不同 runAttemptId）
    const manifest2 = { version: 1, runId, runAttemptId: att2, rootRunId: runId, startedAt: 3000, endedAt: 4000, status: "completed" as const, completeness: "full" as const, sessions: [] }
    store.writeManifest(runId, manifest2 as never, att2)
    store.writeHistory(runId, '{"attempt":2}\n', att2)

    // 验证第一轮数据未被覆盖
    const read1 = store.readManifest(runId, att1)
    assert.ok(read1, "第一轮 manifest 应存在")
    assert.equal(read1!.runAttemptId, att1, "第一轮 manifest 应保留原始 runAttemptId")

    // 验证第二轮数据独立
    const read2 = store.readManifest(runId, att2)
    assert.ok(read2, "第二轮 manifest 应存在")
    assert.equal(read2!.runAttemptId, att2, "第二轮 manifest 应有新 runAttemptId")

    // 两轮数据在不同目录
    assert.notEqual(store.runDir(runId, att1), store.runDir(runId, att2), "两轮目录应不同")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================
// 3. sanitizeForPath 处理冒号（Windows 兼容）
// ============================================================

test("sanitizeForPath: 冒号替换为短横线", () => {
  assert.equal(sanitizeForPath("run-test:abc"), "run-test-abc")
  assert.equal(sanitizeForPath("run-test:attempt:1"), "run-test-attempt-1")
  assert.equal(sanitizeForPath("safe-id"), "safe-id")
})

test("sanitizeForPath: 其他特殊字符也替换", () => {
  assert.equal(sanitizeForPath('a<b>c|d?e*f"g'), "a-b-c-d-e-f-g")
  assert.equal(sanitizeForPath("a\\b/c"), "a-b-c")
})

// ============================================================
// 4. makeJobKey 一致性
// ============================================================

test("makeJobKey: 有 runAttemptId 用复合键", () => {
  assert.equal(makeJobKey("run-1", "run-1:att1"), "run-1:run-1:att1")
})

test("makeJobKey: 无 runAttemptId 回退到 runId", () => {
  assert.equal(makeJobKey("run-1", undefined), "run-1")
  assert.equal(makeJobKey("run-1"), "run-1")
})

// ============================================================
// 5. readToolOutput 真实文件读取测试
// ============================================================

test("readToolOutput: 真实文件可读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "p32-readtool-"))
  try {
    const testFile = join(dir, "output.txt")
    const content = "test output content\nline 2"
    writeFileSync(testFile, content, "utf8")

    // 构造一个模拟的 OpenCodeSessionAdapter 实例
    // 只测试 readToolOutput 方法（它是独立的，不依赖 SDK）
    const adapter = Object.create(OpenCodeSessionAdapter.prototype)

    const result = adapter.readToolOutput({
      callID: "c1", tool: "bash", messageID: "m1", partID: "p1",
      status: "completed", input: {}, partIndex: 0, messageIndex: 0,
      metadata: { outputPath: testFile },
      agentId: "a1", agentLabel: "A", sessionId: "s1",
      workflowScopePath: ["root"], replayed: false,
    }, dir)

    assert.equal(result, content, "应能读取真实文件内容")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readToolOutput: 超出允许目录返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "p32-safe-"))
  const outsideDir = mkdtempSync(join(tmpdir(), "p32-outside-"))
  try {
    const outsideFile = join(outsideDir, "secret.txt")
    writeFileSync(outsideFile, "secret", "utf8")

    const adapter = Object.create(OpenCodeSessionAdapter.prototype)

    const result = adapter.readToolOutput({
      callID: "c1", tool: "bash", messageID: "m1", partID: "p1",
      status: "completed", input: {}, partIndex: 0, messageIndex: 0,
      metadata: { outputPath: outsideFile },
      agentId: "a1", agentLabel: "A", sessionId: "s1",
      workflowScopePath: ["root"], replayed: false,
    }, dir)

    assert.equal(result, null, "项目目录外的文件不应被读取")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})

test("readToolOutput: 超过 1MB 返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "p32-large-"))
  try {
    const largeFile = join(dir, "large.txt")
    // 写入 2MB 数据
    writeFileSync(largeFile, "x".repeat(2 * 1024 * 1024), "utf8")

    const adapter = Object.create(OpenCodeSessionAdapter.prototype)

    const result = adapter.readToolOutput({
      callID: "c1", tool: "bash", messageID: "m1", partID: "p1",
      status: "completed", input: {}, partIndex: 0, messageIndex: 0,
      metadata: { outputPath: largeFile },
      agentId: "a1", agentLabel: "A", sessionId: "s1",
      workflowScopePath: ["root"], replayed: false,
    }, dir)

    assert.equal(result, null, "超过 1MB 的文件不应被读取")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readToolOutput: 无 outputPath 返回 null", () => {
  const adapter = Object.create(OpenCodeSessionAdapter.prototype)

  const result = adapter.readToolOutput({
    callID: "c1", tool: "bash", messageID: "m1", partID: "p1",
    status: "completed", input: {}, partIndex: 0, messageIndex: 0,
    metadata: {},
    agentId: "a1", agentLabel: "A", sessionId: "s1",
    workflowScopePath: ["root"], replayed: false,
  }, "/tmp")

  assert.equal(result, null, "无 outputPath 应返回 null")
})

// ============================================================
// 6. isConfirmedExecution 收紧验证
// ============================================================

test("isConfirmedExecution: grep 不算执行", () => {
  const events = [
    { ...FIXTURES.scriptExtraction()[0], callID: "create-1" },
    { ...FIXTURES.scriptExtraction()[1], callID: "grep-1", input: { command: "grep 'pattern' validate.py" }, startedAt: 2000, endedAt: 2100 },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "grep 不是执行形式，不应产生候选")
})

test("isConfirmedExecution: rm 不算执行", () => {
  const events = [
    { ...FIXTURES.scriptExtraction()[0], callID: "create-1" },
    { ...FIXTURES.scriptExtraction()[1], callID: "rm-1", input: { command: "rm validate.py" }, startedAt: 2000, endedAt: 2100 },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "rm 不是执行形式，不应产生候选")
})

test("isConfirmedExecution: sed 不算执行", () => {
  const events = [
    { ...FIXTURES.scriptExtraction()[0], callID: "create-1" },
    { ...FIXTURES.scriptExtraction()[1], callID: "sed-1", input: { command: "sed -n 1p validate.py" }, startedAt: 2000, endedAt: 2100 },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "sed 不是执行形式，不应产生候选")
})

test("isConfirmedExecution: printf 不算执行", () => {
  const events = [
    { ...FIXTURES.scriptExtraction()[0], callID: "create-1" },
    { ...FIXTURES.scriptExtraction()[1], callID: "printf-1", input: { command: "printf validate.py" }, startedAt: 2000, endedAt: 2100 },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 0, "printf 不是执行形式，不应产生候选")
})

test("isConfirmedExecution: python script.py 算执行", () => {
  const events = FIXTURES.scriptExtraction()
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1, "python validate.py 应为确认执行")
  assert.equal(candidates[0].executionEvents.length, 1)
})

test("isConfirmedExecution: ./script.sh 算执行（shell 脚本直接执行）", () => {

  const events: AnalysisToolEvent[] = [
    { callID: "c1", tool: "write", messageID: "m1", partID: "p1", status: "completed", input: { filePath: "run.sh", content: "#!/bin/bash\necho hello" }, startedAt: 1000, endedAt: 1100, partIndex: 0, messageIndex: 0, agentId: "a1", agentLabel: "A", sessionId: "s1", workflowScopePath: ["root"], replayed: false },
    { callID: "c2", tool: "bash", messageID: "m2", partID: "p2", status: "completed", input: { command: "./run.sh" }, output: "hello", startedAt: 2000, endedAt: 2100, partIndex: 0, messageIndex: 0, agentId: "a1", agentLabel: "A", sessionId: "s1", workflowScopePath: ["root"], replayed: false },
  ]
  const candidates = detectScriptExtractions(events)
  assert.equal(candidates.length, 1, "./run.sh 应为确认执行")
})

// ============================================================
// 7. stableStringify 签名稳定性
// ============================================================

test("stableStringify: 嵌套数组 + 特殊字符键的签名稳定性", () => {
  const a = { items: [{ name: "test", 'key"with"quotes': 1 }], value: "hello" }
  const b = { value: "hello", items: [{ 'key"with"quotes': 1, name: "test" }] }
  assert.equal(stableStringify(a), stableStringify(b), "键顺序不同但内容相同应序列化一致")

  const sigA = signature("tool", a)
  const sigB = signature("tool", b)
  assert.equal(sigA, sigB, "签名应稳定")
})

test("stableStringify: 嵌套数组保持顺序", () => {
  const a = { items: [1, 2, 3] }
  const b = { items: [3, 2, 1] }
  assert.notEqual(stableStringify(a), stableStringify(b), "数组顺序不同应序列化不同")
})
