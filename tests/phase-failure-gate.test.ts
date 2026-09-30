/**
 * 阶段失败闸门 + 排队计时修复测试（Bug1 / Bug2）
 *
 * Bug1 覆盖：phase() 边界拦截、同 phase 收尾、最后 phase 终检、fallback/race 吸收清除、
 *           continueOnAgentFailure 逃生口、缺省重试 1 次、失败报告明细
 * Bug2 覆盖：并发排队期不计 startedAt（第二个 agent 的计时从拿到槽位开始）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"

/** 可控失败 runner：指定 prompt 关键词的调用抛可恢复错误（每次都抛） */
function makeFailingRunner(failKey: string) {
  const calls: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      calls.push(prompt)
      if (prompt.includes(failKey)) throw new Error(`模拟失败:${prompt.slice(0, 10)}`)
      return { value: `ok:${prompt.slice(0, 12)}`, sessionId: "s", type: "text" }
    },
  }
  return { runner, calls }
}

test("闸门：agent 重试耗尽后，下一 phase() 边界终止并报告明细", async () => {
  const { runner, calls } = makeFailingRunner("坏任务")
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'gate_basic' }
phase('扫描')
await agent('坏任务 甲')
phase('汇总')
return await agent('不应执行的汇总')
return 'never'`,
      { agent: runner, agentRetries: 0 },
    ),
    (e: any) => {
      assert.equal(e.code, "WORKFLOW_FAILED")
      assert.match(e.message, /阶段失败闸门/)
      assert.match(e.message, /坏任务/)
      return true
    },
  )
  assert.ok(!calls.some((c) => c.includes("不应执行")), "下一阶段的 agent 未执行")
})

test("闸门：同 phase 后续 agent 照常收尾（阶段边界才拦）", async () => {
  const { runner, calls } = makeFailingRunner("坏任务")
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'gate_same_phase' }
phase('扫描')
await agent('坏任务 甲')
const tail = await agent('同阶段正常任务')
phase('下一步')
return 'never'`,
      { agent: runner, agentRetries: 0 },
    ),
    (e: any) => e.code === "WORKFLOW_FAILED",
  )
  assert.ok(calls.some((c) => c.includes("同阶段正常")), "同 phase 的后续 agent 已执行（收尾）")
})

test("闸门：失败在最后 phase 且脚本正常 return，终检同样终止", async () => {
  const { runner } = makeFailingRunner("坏任务")
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'gate_last_phase' }
phase('干活')
const a = await agent('坏任务 甲')
return { a }`,
      { agent: runner, agentRetries: 0 },
    ),
    (e: any) => e.code === "WORKFLOW_FAILED",
  )
})

test("闸门：fallback 降级成功吸收失败，run 正常完成", async () => {
  const { runner } = makeFailingRunner("坏任务")
  const result = await runWorkflow(
    `export const meta = { name: 'gate_fallback' }
phase('降级')
const r = await fallback([
  () => agent('坏任务 快路径'),
  () => agent('慢路径兜底'),
])
phase('汇总')
return { r }`,
    { agent: runner, agentRetries: 0 },
  )
  assert.match(String((result.result as any).r), /^ok:慢路径兜底/, "降级成功")
})

test("闸门：race 败者失败被胜者吸收，run 正常完成", async () => {
  const { runner } = makeFailingRunner("坏任务")
  const result = await runWorkflow(
    `export const meta = { name: 'gate_race' }
phase('竞争')
const r = await race([
  () => { throw new Error('直接死') },
  () => agent('正常竞争者'),
])
phase('汇总')
return r`,
    { agent: runner, agentRetries: 0 },
  )
  assert.match(String(result.result), /^ok:正常竞争者/)
})

test("逃生口：continueOnAgentFailure=true 恢复旧静默语义", async () => {
  const { runner } = makeFailingRunner("坏任务")
  const result = await runWorkflow(
    `export const meta = { name: 'gate_escape' }
phase('扫描')
const a = await agent('坏任务 甲')
phase('汇总')
const b = await agent('汇总任务')
return { a: a === null, b }`,
    { agent: runner, agentRetries: 0, continueOnAgentFailure: true },
  )
  const out = JSON.parse(JSON.stringify(result.result))
  assert.equal(out.a, true, "失败塌缩 null（旧行为）")
  assert.match(out.b, /^ok:汇总/)
})

test("缺省重试：可恢复失败默认重试 1 次，第二次成功即通过", async () => {
  const calls: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      calls.push(prompt)
      if (calls.length === 1) throw new Error("第一次抖动")
      return { value: "ok:second", sessionId: "s", type: "text" }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'default_retry' }
phase('干活')
return await agent('任务')`,
    { agent: runner },
  )
  assert.equal(result.result, "ok:second")
  assert.equal(calls.length, 2, "默认重试一次后成功")
})

test("缺省重试：重试一次仍失败即耗尽（2 次尝试），触发闸门", async () => {
  const { runner, calls } = makeFailingRunner("坏任务")
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'default_retry_fail' }
phase('干活')
await agent('坏任务 甲')
return 'never'`,
      { agent: runner },
    ),
    (e: any) => e.code === "WORKFLOW_FAILED",
  )
  assert.equal(calls.length, 2, "缺省 1 次重试 = 共 2 次尝试")
})

test("Bug2：并发排队期不计时——第二个 agent 的 startedAt 在第一个完成之后", async () => {
  const events: Array<{ label: string; startedAt?: number; durationMs?: number; status: string }> = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      await new Promise((r) => setTimeout(r, 80))
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'queue_timer' }
const rs = await parallel([
  () => agent('第一个', { label: '第一个' }),
  () => agent('第二个', { label: '第二个' }),
])
return rs.length`,
    {
      agent: runner,
      concurrency: 1,
      onAgentUpdate: (r) => events.push({ label: r.label, startedAt: r.startedAt, durationMs: r.durationMs, status: r.status }),
    },
  )
  assert.equal(result.result, 2)
  const first = result.agents.find((a) => a.label === "第一个")!
  const second = result.agents.find((a) => a.label === "第二个")!
  // 修复后：第二个的计时起点 >= 第一个的结束（排队期不计入）
  assert.ok(
    (second.startedAt ?? 0) >= (first.startedAt ?? 0) + (first.durationMs ?? 0) - 15,
    `第二个 startedAt(${second.startedAt}) 应 >= 第一个结束(${(first.startedAt ?? 0) + (first.durationMs ?? 0)})，含 15ms 调度容差`,
  )
  assert.ok((second.durationMs ?? 999) < 150, "第二个的耗时不应含 80ms 排队等待")
})

test("#32/#33 数据面：重试中间态推送 attempt/maxAttempts，record 携带生效 timeout", async () => {
  let n = 0
  const updates: Array<{ attempt?: number; maxAttempts?: number }> = []
  const runner: AgentSessionRunner = {
    async run() {
      n++
      if (n <= 2) throw new Error(`第 ${n} 次失败`)
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'retry_progress' }
phase('干活')
return await agent('三次才成', { retries: 2, timeoutMs: 30000 })`,
    {
      agent: runner,
      onAgentUpdate: (r) => {
        if (r.attempt !== undefined) updates.push({ attempt: r.attempt, maxAttempts: r.maxAttempts })
      },
    },
  )
  assert.equal(result.result, "ok")
  // 中间态：attempt=2 的推送出现过（第 1 次不推、第 2 次推、第 3 次推）
  assert.ok(updates.some((u) => u.attempt === 2 && u.maxAttempts === 3), "attempt=2 中间态可见")
  assert.ok(updates.some((u) => u.attempt === 3 && u.maxAttempts === 3), "attempt=3 可见")
  // timeout 面板：单 agent timeoutMs 进 record
  assert.equal(result.agents[0].timeoutMs, 30000)
  assert.equal(result.agents[0].maxAttempts, 3)
  assert.equal(result.agents[0].attempt, 3)
})
