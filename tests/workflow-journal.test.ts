/**
 * journal / resume 测试（P1-1，照搬 pi-dynamic-workflows 的测试语义）
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
import type { JournalEntry } from "../src/types/index.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"

function countingAgent() {
  const calls: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      calls.push(prompt)
      return `echo:${prompt}`
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
