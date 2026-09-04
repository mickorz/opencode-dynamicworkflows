/**
 * Workflow Runtime 测试（fake runner 注入模式，照搬 pi-dynamic-workflows tests 的套路）
 *
 * 覆盖面：
 *  - meta 信封校验（缺失/非法 name）
 *  - 确定性 blocklist（Date.now / Math.random / new Date()）
 *  - agent() 基本执行、结果返回、默认 label、tokens 回传
 *  - parallel：顺序保持、Promise 数组报错、可恢复失败塌缩 null、不可恢复失败上抛
 *  - pipeline：stage 顺序与 (prev, original, index) 参数
 *  - 并发上限（deferred gate 断言 maxActive）
 *  - phase/log 记录、args 全局、schema 透传
 *  - 超时、重试、abort、agent 至少调用一次、agent 数量上限
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import { WorkflowError } from "../src/runtime/errors.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"

/** 计数 fake：回显 prompt，上报固定用量 */
function countingAgent() {
  const calls: Array<{ prompt: string; options?: AgentRunOptions }> = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push({ prompt, options })
      options?.onUsage?.({ input: 10, output: 5, total: 15 })
      return `echo:${prompt}`
    },
  }
  return { runner, calls }
}

/** 可放行的 fake：用于并发上限断言 */
function gatedAgent() {
  let active = 0
  let maxActive = 0
  const gates: Array<() => void> = []
  const runner: AgentSessionRunner = {
    run() {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise((resolve) => {
        gates.push(() => {
          active--
          resolve("ok")
        })
      })
    },
  }
  return {
    runner,
    releaseAll: () => gates.splice(0).forEach((release) => release()),
    maxActive: () => maxActive,
  }
}

test("缺少 meta 信封被拒绝", async () => {
  await assert.rejects(
    runWorkflow(`await agent('hi')`, { agent: countingAgent().runner }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.match(error.message, /meta/)
      return true
    },
  )
})

test("meta.name 必须是 snake_case", async () => {
  await assert.rejects(
    runWorkflow(`export const meta = { name: 'Bad Name' }\nawait agent('hi')`, {
      agent: countingAgent().runner,
    }),
    /snake_case/,
  )
})

test("确定性 blocklist：Date.now / Math.random / new Date() 解析期拒绝", async () => {
  const { runner } = countingAgent()
  for (const bad of [
    `export const meta = { name: 'x' }\nconst t = Date.now()`,
    `export const meta = { name: 'x' }\nconst r = Math.random()`,
    `export const meta = { name: 'x' }\nconst d = new Date()`,
  ]) {
    await assert.rejects(runWorkflow(bad, { agent: runner }), /确定性|deterministic|unavailable/i)
  }
})

test("agent() 执行并返回结果，记录默认 label 与 tokens", async () => {
  const { runner, calls } = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'single', description: '单个 agent' }
const r = await agent('分析文档A')
return r`,
    { agent: runner },
  )
  assert.equal(result.result, "echo:分析文档A")
  assert.equal(result.agentCount, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options?.label, "agent 1")
  assert.equal(result.agents[0].status, "ok")
  assert.equal(result.agents[0].tokens, 15)
})

test("parallel：结果保持输入顺序，可恢复失败塌缩为 null", async () => {
  const runner: AgentSessionRunner = {
    async run(prompt) {
      if (prompt.includes("fail")) throw new Error("模拟网络失败")
      return `ok:${prompt}`
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'par' }
const rs = await parallel([
  () => agent('a'),
  () => agent('fail-b'),
  () => agent('c'),
])
return rs`,
    { agent: runner },
  )
  assert.deepEqual(result.result, ["ok:a", null, "ok:c"])
  assert.equal(result.agents[1].status, "failed")
  assert.equal(result.agentCount, 3)
})

test("parallel：传 Promise 数组直接报错", async () => {
  const { runner } = countingAgent()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'par_promise' }
await parallel([agent('a'), agent('b')])`,
      { agent: runner },
    ),
    /函数数组/,
  )
})

test("pipeline：stage 依序执行并收到 (prev, original, index)", async () => {
  const { runner } = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'pipe' }
const rs = await pipeline(
  ['a', 'b'],
  (item) => item.toUpperCase(),
  async (prev, original, index) => prev + ':' + original + ':' + index + ':' + (await agent('q' + index)),
)
return rs`,
    { agent: runner },
  )
  assert.deepEqual(result.result, ["A:a:0:echo:q0", "B:b:1:echo:q1"])
})

test("并发上限：concurrency 2 时同时最多 2 个 agent", async () => {
  const gate = gatedAgent()
  const timer = setInterval(() => gate.releaseAll(), 10)
  try {
    const result = await runWorkflow(
      `export const meta = { name: 'conc' }
await parallel([0, 1, 2, 3, 4].map(i => () => agent('t' + i)))
return 'done'`,
      { agent: gate.runner, concurrency: 2 },
    )
    assert.equal(result.result, "done")
    assert.equal(gate.maxActive(), 2)
  } finally {
    clearInterval(timer)
  }
})

test("phase 与 log 被记录；声明 meta.phases 时未分组 agent 归入首个 phase", async () => {
  const { runner } = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'phased', phases: [{ title: 'Scan' }, { title: 'Review' }] }
await agent('扫描')
phase('Review')
log('进入评审')
await agent('评审')
return 'done'`,
    { agent: runner },
  )
  assert.deepEqual(result.phases, ["Scan", "Review"])
  assert.ok(result.logs.includes("进入评审"))
  assert.equal(result.agents[0].phase, "Scan")
  assert.equal(result.agents[1].phase, "Review")
})

test("args 全局与 schema 透传到 runner", async () => {
  const { runner, calls } = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'schema_args' }
const rs = await parallel(args.files.map(f => () =>
  agent('分析 ' + f, { schema: { type: 'object', properties: { risk: { type: 'string' } } } })
))
return rs`,
    { agent: runner, args: { files: ["x.md", "y.md"] } },
  )
  assert.deepEqual(result.result, ["echo:分析 x.md", "echo:分析 y.md"])
  // schema 来自 vm 域（跨域原型），用 JSON 字符串比较数据等价（真实链路本来就是 HTTP JSON 序列化）
  assert.equal(
    JSON.stringify(calls[0].options?.schema),
    JSON.stringify({ type: "object", properties: { risk: { type: "string" } } }),
  )
})

test("可恢复失败自动重试后成功", async () => {
  let attempts = 0
  const runner: AgentSessionRunner = {
    async run() {
      attempts++
      if (attempts === 1) throw new Error("第一次失败")
      return "ok"
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'retry' }
return await agent('任务')`,
    { agent: runner, agentRetries: 1 },
  )
  assert.equal(result.result, "ok")
  assert.equal(attempts, 2)
  assert.equal(result.agents[0].status, "ok")
})

test("超时的 agent 重试耗尽后返回 null 且标记 failed", async () => {
  const runner: AgentSessionRunner = {
    run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
  }
  const result = await runWorkflow(
    `export const meta = { name: 'timeout' }
return await agent('慢任务', { timeoutMs: 20 })`,
    { agent: runner },
  )
  assert.equal(result.result, null)
  assert.equal(result.agents[0].status, "failed")
})

test("run 级 signal abort 后 agent() 抛出 WORKFLOW_ABORTED", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runWorkflow(`export const meta = { name: 'abort' }\nawait agent('x')`, {
      agent: countingAgent().runner,
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.equal(error.code, "WORKFLOW_ABORTED")
      return true
    },
  )
})

test("agent 至少调用一次，否则拒绝", async () => {
  await assert.rejects(
    runWorkflow(`export const meta = { name: 'no_agent' }\nreturn 1 + 1`, {
      agent: countingAgent().runner,
    }),
    /至少调用一次 agent/,
  )
})

test("空 prompt 被拒绝", async () => {
  await assert.rejects(
    runWorkflow(`export const meta = { name: 'empty_prompt' }\nawait agent('   ')`, {
      agent: countingAgent().runner,
    }),
    /非空 prompt/,
  )
})

test("maxAgents 超限时抛 AGENT_LIMIT_EXCEEDED", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'limit' }
await agent('a')
await agent('b')`,
      { agent: countingAgent().runner, maxAgents: 1 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.equal(error.code, "AGENT_LIMIT_EXCEEDED")
      return true
    },
  )
})

test("parallel 中的不可恢复失败上抛而非塌缩 null", async () => {
  const runner: AgentSessionRunner = {
    async run() {
      throw new WorkflowError("校验失败", "SCRIPT_VALIDATION_ERROR" as never, { recoverable: false })
    },
  }
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'nonrec' }
await parallel([() => agent('a'), () => agent('b')])`,
      { agent: runner },
    ),
    /校验失败/,
  )
})
