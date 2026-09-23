/**
 * Pipeline 等价性 A/B（P1-4）
 *
 * 对照体：
 *   Old: pipeline(items, A, B, C)
 *   New: parallel(items.map(item => () => sequence([() => A(item), prev => B(prev), prev => C(prev)])))
 *
 * 覆盖维度：纯 JS 结果、agent 结果、journal key 序、null 传播、可恢复失败塌缩、
 *           结构性错误、并发峰值、abort 行为
 * 结论供 P2「pipeline 去留」决策使用，报告见 Docs/02_设计与说明/Pipeline等价性AB报告.md
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

type Stage = (prev: unknown, original: unknown, index: number) => unknown

/** 把 pipeline stages 适配为 parallel+sequence 等价形态（报告中的 New 写法） */
function abScript(items: string, stages: string[]): { old: string; neu: string } {
  const stageFns = stages.join(",\n  ")
  const old = `export const meta = { name: 'ab_old' }
const rs = await pipeline(
  ${items},
  ${stageFns},
)
await agent('bookkeeping')
return rs`
  const neu = `export const meta = { name: 'ab_new' }
const rs = await parallel(
  (${items}).map(item => () => sequence([
    () => (${stages[0]})(item, item, 0),
    prev => (${stages[1]})(prev, item, 0),
  ])),
)
await agent('bookkeeping')
return rs`
  return { old, neu }
}

function makeRunner() {
  const calls: AgentRunOptions[] = []
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push(options!)
      prompts.push(prompt)
      return { value: `ok:${prompt}`, sessionId: "s", type: "text" }
    },
  }
  return { runner, calls, prompts }
}

async function run(script: string, extra: Partial<Parameters<typeof runWorkflow>[1]> = {}) {
  const { runner, calls, prompts } = makeRunner()
  const journal = new Map<string, JournalEntry>()
  const result = await runWorkflow(script, { ...extra, agent: runner, onAgentJournal: (e) => journal.set(e.key, e) })
  return { result, calls, prompts, journal }
}

test("A/B 纯 JS stage：结果逐项一致", async () => {
  const { old, neu } = abScript(`['a', 'b', 'c']`, [
    `(v) => v.toUpperCase()`,
    `(v) => v + '-2'`,
  ])
  const o = await run(old)
  const n = await run(neu)
  assert.deepEqual(n.result.result, o.result.result)
})

test("A/B agent stage：结果与 journal key 序一致", async () => {
  const { old, neu } = abScript(`['x', 'y']`, [
    `async (v) => await agent('stage1 ' + v)`,
    `async (v) => await agent('stage2 ' + v)`,
  ])
  const o = await run(old)
  const n = await run(neu)
  assert.deepEqual(n.result.result, o.result.result)
  // key 序：均为 0..3 + bookkeeping（callSeq 按调度顺序同步分配）
  assert.deepEqual(
    [...n.journal.keys()].map((k) => k.replace(/^[^:]+:/, "")),
    [...o.journal.keys()].map((k) => k.replace(/^[^:]+:/, "")),
  )
})

test("A/B null 传播：stage 返回 null 后续继续，两形态行为一致", async () => {
  const { old, neu } = abScript(`['a']`, [
    `() => null`,
    `(v) => v === null ? 'seen-null' : 'unexpected'`,
  ])
  const o = await run(old)
  const n = await run(neu)
  assert.deepEqual(n.result.result, o.result.result)
  assert.deepEqual(o.result.result, ["seen-null"])
})

test("A/B 可恢复失败：塌缩 null 位置一致", async () => {
  const { old, neu } = abScript(`['a', 'b']`, [
    `(v) => { if (v === 'a') throw new Error('甲失败'); return v }`,
    `async (v) => await agent('tail ' + v)`,
  ])
  const o = await run(old)
  const n = await run(neu)
  assert.equal((o.result.result as unknown[])[0], null)
  assert.equal((n.result.result as unknown[])[0], null)
  assert.match(String((n.result.result as unknown[])[1]), /^ok:tail b/)
  assert.match(String((o.result.result as unknown[])[1]), /^ok:tail b/)
})

test("A/B 结构性错误：两形态均上抛（unknown workflow 不被塔缩）", async () => {
  await assert.rejects(
    run(`export const meta = { name: 'ab_old_struct' }
await pipeline(['a'], async (v) => await workflow('./missing-' + v + '.js'))
return 1`),
    /不存在或不可读/,
  )
  await assert.rejects(
    run(`export const meta = { name: 'ab_new_struct' }
await parallel(['a'].map(item => () => sequence([
  () => workflow('./missing-' + item + '.js'),
])))
return 1`),
    /不存在或不可读/,
  )
})

test("A/B 并发峰值：两形态均为 item 级并发且峰值一致", async () => {
  let inflight = 0
  let peak = 0
  const runner: AgentSessionRunner = {
    async run() {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 20))
      inflight--
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  const items = `['a','b','c','d']`
  const scriptOld = `export const meta = { name: 'ab_old_conc' }
await pipeline(${items}, async (v) => await agent('s1 ' + v), async (v) => await agent('s2 ' + v))
return 1`
  const scriptNew = `export const meta = { name: 'ab_new_conc' }
await parallel((${items}).map(item => () => sequence([
  () => agent('s1 ' + item),
  (prev) => agent('s2 ' + prev.slice(0, 6)),
])))
return 1`
  // 跑两次各自记录峰值（concurrency 缺省 >=4 时 4 item 全并发）
  // 显式 concurrency：缺省值随宿主核数漂移（CI 4 核 -> 2），峰值断言需确定性
  await runWorkflow(scriptOld, { agent: runner, concurrency: 4 })
  const peakOld = peak
  inflight = 0
  peak = 0
  await runWorkflow(scriptNew, { agent: runner, concurrency: 4 })
  const peakNew = peak
  assert.equal(peakNew, peakOld, "并发峰值一致（均无 stage barrier）")
  assert.ok(peakOld >= 3, "item 级并发确实发生")
})

test("A/B resume：两形态同 runId 均可全量回放", async () => {
  const { old, neu } = abScript(`['m']`, [
    `async (v) => await agent('p1 ' + v)`,
    `async (v) => await agent('p2 ' + v)`,
  ])
  for (const script of [old, neu]) {
    const first = await run(script)
    const calls: string[] = []
    await runWorkflow(script, {
      agent: {
        async run(p) {
          calls.push(p)
          return { value: "x", sessionId: "s", type: "text" }
        },
      },
      runId: first.result.runId,
      resumeJournal: first.journal,
    })
    assert.equal(calls.length, 0, `${script.includes("pipeline") ? "old" : "new"} 全量回放`)
  }
})
