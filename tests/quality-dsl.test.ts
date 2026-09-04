/**
 * 质量与控制 DSL 测试（P1-4：verify / judgePanel / retry / checkpoint）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"

/** schema 型 fake：按 prompt 前缀返回固定结构化结果 */
function schemaAgent(map: Array<{ match: string; result: unknown }>): {
  runner: AgentSessionRunner
  calls: Array<{ prompt: string; options?: AgentRunOptions }>
} {
  const calls: Array<{ prompt: string; options?: AgentRunOptions }> = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push({ prompt, options })
      for (const entry of map) {
        if (prompt.includes(entry.match)) return entry.result
      }
      return {}
    },
  }
  return { runner, calls }
}

test("verify：两票全真 -> real=true，schema 正确传递", async () => {
  const { runner, calls } = schemaAgent([{ match: "Adversarially review", result: { real: true, reason: "ok" } }])
  const result = await runWorkflow(
    `export const meta = { name: 'v1' }
const verdict = await verify('地球绕太阳转')
return verdict`,
    { agent: runner },
  )
  const verdict = result.result as { real: boolean; realCount: number; total: number }
  assert.equal(verdict.real, true)
  assert.equal(verdict.realCount, 2)
  assert.equal(verdict.total, 2)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].options?.schema, {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  })
})

test("verify：一真一假，threshold 1 -> real=false", async () => {
  let n = 0
  const runner: AgentSessionRunner = {
    async run() {
      n++
      return { real: n === 1, reason: "" }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'v2' }
return await verify('待核断言', { reviewers: 2, threshold: 1 })`,
    { agent: runner },
  )
  assert.equal((result.result as { real: boolean }).real, false)
})

test("verify：reviewer 失败塌缩为弃权票，不计入 total", async () => {
  const runner: AgentSessionRunner = {
    async run(prompt) {
      if (prompt.includes("Adversarially")) throw new Error("评审失败")
      return "unused"
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'v3' }
return await verify('x', { reviewers: 2 })`,
    { agent: runner },
  )
  const verdict = result.result as { real: boolean; total: number }
  assert.equal(verdict.total, 0)
  assert.equal(verdict.real, false, "零票时判 false（与 Pi 一致：votes.length > 0 才可能为真）")
})

test("judgePanel：多候选多评审，返回最高均分与原始 index；null 候选被过滤", async () => {
  // judge i.j：候选 1 全部 0.9 分，候选 2 全部 0.4 分（按 Candidate 内容区分）
  const runner: AgentSessionRunner = {
    async run(prompt) {
      const high = prompt.includes("GOOD_CANDIDATE")
      return { score: high ? 0.9 : 0.4, reason: "" }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'j1' }
const best = await judgePanel(
  ['BAD_CANDIDATE', null, 'GOOD_CANDIDATE'].filter(x => x),
  { judges: 2, rubric: 'correctness' }
)
return { index: best.index, score: best.score, attempt: best.attempt }`,
    { agent: runner },
  )
  const best = result.result as { index: number; score: number; attempt: string }
  assert.equal(best.attempt, "GOOD_CANDIDATE")
  assert.equal(best.score, 0.9)
  assert.equal(best.index, 1, "保留原始输入下标（null 被过滤但下标不变）")
})

test("retry：until 通过即停；耗尽返回最后一次结果", async () => {
  let calls = 0
  const runner: AgentSessionRunner = {
    async run() {
      calls++
      return { v: calls }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'r1' }
const a = await retry(() => agent('gen'), { attempts: 5, until: (r) => r && r.v })
return a`,
    { agent: runner },
  )
  assert.equal(calls, 1, "第一次即满足 until")
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { v: 1 })

  // until 永假 -> 耗尽返回最后一次
  let calls2 = 0
  const runner2: AgentSessionRunner = {
    async run() {
      calls2++
      return calls2
    },
  }
  const result2 = await runWorkflow(
    `export const meta = { name: 'r2' }\nreturn await retry(() => agent('gen'), { attempts: 3, until: () => false })`,
    { agent: runner2 },
  )
  assert.equal(calls2, 3)
  assert.equal(result2.result, 3)
})

test("checkpoint：headless 取 default 并写 journal；resume 回放不再询问", async () => {
  const script = `export const meta = { name: 'c1' }
const ok = await checkpoint('确认继续？', { default: false })
return [ok, await agent('干活')]`
  const asked: string[] = []
  const journal = new Map()
  const first = await runWorkflow(script, {
    agent: { run: async () => "done" } as AgentSessionRunner,
    confirm: async (p) => {
      asked.push(p)
      return true
    },
    onAgentJournal: (e) => journal.set(e.key, e),
  })
  // 有 confirm 通道时优先走人工（返回 true），default 不生效
  assert.deepEqual(asked, ["确认继续？"])
  assert.equal(JSON.stringify(first.result), JSON.stringify([true, "done"]))
  // checkpoint 也进 journal（0 号）且 agent（1 号）进 journal
  assert.equal(journal.size, 2)

  // resume：同脚本回放，confirm 不再被调用，agent 不重跑
  const asked2: string[] = []
  let liveCalls = 0
  const resumed = await runWorkflow(script, {
    agent: {
      run: async () => {
        liveCalls++
        return "done"
      },
    } as AgentSessionRunner,
    confirm: async (p) => {
      asked2.push(p)
      return false
    },
    runId: first.runId,
    resumeJournal: journal,
  })
  assert.equal(asked2.length, 0, "checkpoint 回放不应再询问")
  assert.equal(liveCalls, 0, "agent 回放不重跑")
  assert.equal(JSON.stringify(resumed.result), JSON.stringify([true, "done"]))
})

test("checkpoint：无 confirm 通道时 headless abort 抛错；缺省 default 为 true", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'c2' }\nawait checkpoint('必须人工', { headless: 'abort' })`,
      { agent: { run: async () => "x" } as AgentSessionRunner },
    ),
    /headless/,
  )

  const journal = new Map()
  const result = await runWorkflow(
    `export const meta = { name: 'c3' }\nreturn await checkpoint('默认继续')`,
    { agent: { run: async () => "x" } as AgentSessionRunner, onAgentJournal: (e) => journal.set(e.key, e) },
  )
  assert.equal(result.result, true, "缺省 default 为 true")
  assert.equal(journal.size, 1, "checkpoint 结果进 journal")
})
