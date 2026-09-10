/**
 * journal / resume 测试（P1-1）
 *
 * 覆盖：
 *  - 成功 agent 触发 onAgentJournal（key = runId:callIndex，含 hash/result）
 *  - 失败耗尽的 null 结果不进 journal
 *  - 全量回放：resume 后 fake 计数为 0，record.replayed = true
 *  - 最长未变前缀：改第 2 个 agent 的 prompt -> 2、3 重跑，1 回放
 *  - 历史 journal 里的空文本结果不回放（重跑）
 *  - JournalStore 文件读写 roundtrip 与追加合并
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import { JournalStore } from "../src/persistence/journal.js"
import type { JournalEntry, AgentExecutionRecord } from "../src/types/index.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import { textResult } from "./helpers.js"

function countingAgent() {
  const calls: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      calls.push(prompt)
      return textResult(`echo:${prompt}`)
    },
  }
  return { runner, calls }
}

async function runOnce(script: string, runner: AgentSessionRunner) {
  const journal = new Map<string, JournalEntry>()
  const result = await runWorkflow(script, {
    agent: runner,
    onAgentJournal: (entry) => journal.set(entry.key, entry),
  })
  return { result, journal }
}

test("成功的 agent 触发 onAgentJournal，key 与 hash 正确", async () => {
  const { runner } = countingAgent()
  const { result, journal } = await runOnce(
    `export const meta = { name: 'j1' }\nreturn await agent('任务A')`,
    runner,
  )
  assert.equal(journal.size, 1)
  const [key, entry] = [...journal][0]
  assert.equal(key, `${result.runId}:0`)
  assert.equal(entry.result, "echo:任务A")
  assert.match(entry.hash, /^[0-9a-f]{64}$/)
})

test("重试耗尽的 null 结果不进 journal", async () => {
  const runner: AgentSessionRunner = {
    async run() {
      throw new Error("总是失败")
    },
  }
  const { journal } = await runOnce(`export const meta = { name: 'j2' }\nreturn await agent('x')`, runner)
  assert.equal(journal.size, 0)
})

test("resume 全量回放：fake 计数为 0，record 标记 replayed", async () => {
  const first = countingAgent()
  const script = `export const meta = { name: 'j3' }\nreturn [await agent('a'), await agent('b')]`
  const { result, journal } = await runOnce(script, first.runner)
  assert.equal(first.calls.length, 2)

  // 同脚本同 runId 续跑：全部回放
  const second = countingAgent()
  const resumed = await runWorkflow(script, {
    agent: second.runner,
    runId: result.runId,
    resumeJournal: journal,
  })
  assert.equal(second.calls.length, 0, "回放不应触发真实 agent 调用")
  // 结果数组来自 vm 域（跨域原型），用 JSON 比较数据等价
  assert.equal(JSON.stringify(resumed.result), JSON.stringify(["echo:a", "echo:b"]))
  assert.ok(resumed.agents.every((a) => a.replayed))
  assert.ok(resumed.agents.every((a) => (a.tokens ?? 0) === 0))
})

test("最长未变前缀：改第 2 个 prompt 后，2、3 重跑，1 回放", async () => {
  const first = countingAgent()
  const scriptA = `export const meta = { name: 'j4' }
return [await agent('p1'), await agent('p2'), await agent('p3')]`
  const { result, journal } = await runOnce(scriptA, first.runner)

  const scriptB = `export const meta = { name: 'j4' }
return [await agent('p1'), await agent('p2-changed'), await agent('p3')]`
  const second = countingAgent()
  const resumed = await runWorkflow(scriptB, {
    agent: second.runner,
    runId: result.runId,
    resumeJournal: journal,
  })
  // 前缀语义：p1 回放；p2 变更重跑；p3 虽未变但在首个 miss 之后，也重跑
  assert.deepEqual(second.calls, ["p2-changed", "p3"])
  assert.equal(resumed.agents[0].replayed, true)
  assert.equal(resumed.agents[1].replayed, undefined)
  assert.equal(resumed.agents[2].replayed, undefined)
  assert.equal(JSON.stringify(resumed.result), JSON.stringify(["echo:p1", "echo:p2-changed", "echo:p3"]))
})

test("历史 journal 里的空文本结果不回放（视为 miss 重跑）", async () => {
  const first = countingAgent()
  const script = `export const meta = { name: 'j5' }\nreturn await agent('a')`
  const { result, journal } = await runOnce(script, first.runner)
  // 手工把缓存结果改成空串（模拟旧版本/损坏 journal）
  const key = `${result.runId}:0`
  journal.set(key, { ...journal.get(key)!, result: "   " })

  const second = countingAgent()
  const resumed = await runWorkflow(script, {
    agent: second.runner,
    runId: result.runId,
    resumeJournal: journal,
  })
  assert.equal(second.calls.length, 1, "空文本缓存应重跑")
  assert.equal(resumed.agents[0].replayed, undefined)
})

test("JournalStore：load/append roundtrip 与多次追加合并", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-"))
  try {
    const store = new JournalStore(dir)
    assert.equal(store.load("run-x").size, 0, "不存在的 run 返回空")

    store.append("run-x", "run-x:0", { hash: "a", result: "r0" })
    store.append("run-x", "run-x:1", { hash: "b", result: { deep: true }, model: "openai/gpt-x" })

    // 新实例从盘加载（绕过内存缓存）
    const reloaded = new JournalStore(dir).load("run-x")
    assert.equal(reloaded.size, 2)
    assert.deepEqual(reloaded.get("run-x:0"), { hash: "a", result: "r0" })
    assert.deepEqual(reloaded.get("run-x:1"), { hash: "b", result: { deep: true }, model: "openai/gpt-x" })

    // 非法 runId 拒绝（文件名安全）
    assert.throws(() => new JournalStore(dir).append("../evil", "k", { hash: "x", result: 1 }), /非法 runId/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- Node Inspector 扩展 ----

function makeExecution(executionId: string, attempt: number, status: AgentExecutionRecord["status"] = "failed"): AgentExecutionRecord {
  return { executionId, attempt, status, error: "模拟失败", label: "失败节点", sessionId: "sess-x" }
}

test("recordExecution：追加/去重/上限10，且绝不写 hash/result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-exec-"))
  try {
    const store = new JournalStore(dir)
    store.append("run-e", "run-e:0", { hash: "h0", result: "成功结果" })
    store.recordExecution("run-e", "run-e:0", makeExecution("run-e:0:1", 1))
    store.recordExecution("run-e", "run-e:0", makeExecution("run-e:0:2", 2))
    // 同 executionId 去重（重复发射不重复记录）
    store.recordExecution("run-e", "run-e:0", makeExecution("run-e:0:2", 2))

    const reloaded = new JournalStore(dir).load("run-e")
    const entry = reloaded.get("run-e:0")!
    // hash/result 不被 recordExecution 改写
    assert.equal(entry.hash, "h0")
    assert.equal(entry.result, "成功结果")
    assert.equal(entry.executions?.length, 2)
    assert.deepEqual(entry.executions?.map((e) => e.executionId), ["run-e:0:1", "run-e:0:2"])

    // cap 10：灌 12 条，只留最后 10 条
    for (let i = 3; i <= 12; i++) {
      store.recordExecution("run-e", "run-e:0", makeExecution(`run-e:0:${i}`, i))
    }
    const capped = new JournalStore(dir).load("run-e").get("run-e:0")!
    assert.equal(capped.executions?.length, 10)
    assert.equal(capped.executions?.[0].executionId, "run-e:0:3")
    assert.equal(capped.executions?.[9].executionId, "run-e:0:12")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("recordExecution：纯失败 entry 补齐顶层 label/sessionId（快照清理后的 header 兜底）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-failmeta-"))
  try {
    const store = new JournalStore(dir)
    store.recordExecution("run-f", "run-f:0", makeExecution("run-f:0:1", 1))
    const entry = new JournalStore(dir).load("run-f").get("run-f:0")!
    assert.equal(entry.label, "失败节点")
    assert.equal(entry.sessionId, "sess-x")
    assert.equal(entry.hash, undefined, "仍不写 hash")
    assert.equal(entry.result, undefined, "仍不写 result")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("append 浅合并：新载荷不带 executions 时保留已有执行历史", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-journal-merge-"))
  try {
    const store = new JournalStore(dir)
    store.recordExecution("run-m", "run-m:0", makeExecution("run-m:0:1", 1))
    // 随后的成功写入（runtime 载荷不带 executions）不应抹掉失败历史
    store.append("run-m", "run-m:0", { hash: "h", result: { ok: true }, label: "节点A", executionId: "run-m:0:2" })
    const entry = new JournalStore(dir).load("run-m").get("run-m:0")!
    assert.equal(entry.hash, "h")
    assert.deepEqual(entry.result, { ok: true })
    assert.equal(entry.label, "节点A")
    assert.equal(entry.executions?.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("resume 安全：仅有 executions（无 hash）的 entry 必须重跑不回放", async () => {
  // 场景：上次 run 的该节点全是失败尝试（executions 有记录但没写成 hash）
  const journal = new Map<string, JournalEntry>([
    ["run-safe:0", { executions: [makeExecution("run-safe:0:1", 1)] } as JournalEntry],
  ])
  const fake = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'resume_safe' }\nreturn await agent('任务')`,
    { agent: fake.runner, runId: "run-safe", resumeJournal: journal },
  )
  assert.equal(fake.calls.length, 1, "无 hash 的 entry 必须重跑")
  assert.equal(result.agents[0].replayed, undefined)
  assert.equal(result.result, "echo:任务")
})
