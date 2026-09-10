/**
 * Workflow Runtime 测试（fake runner 注入模式）
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
import { textResult, structuredResult } from "./helpers.js"

/** 计数 fake：回显 prompt，上报固定用量 */
function countingAgent() {
  const calls: Array<{ prompt: string; options?: AgentRunOptions }> = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push({ prompt, options })
      options?.onUsage?.({ input: 10, output: 5, total: 15 })
      return textResult(`echo:${prompt}`)
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
          resolve(textResult("ok"))
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
      return textResult(`ok:${prompt}`)
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
      return textResult("ok")
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
    run: () => new Promise((resolve) => setTimeout(() => resolve(textResult("late")), 200)),
  }
  const result = await runWorkflow(
    `export const meta = { name: 'timeout' }
return await agent('慢任务', { timeoutMs: 20, retries: 2 })`,
    { agent: runner, runId: "run-to" },
  )
  assert.equal(result.result, null)
  assert.equal(result.agents[0].status, "failed")
  // 失败节点的 record 也回填最后一次尝试的标识（Node Detail 显示尝试次数）
  assert.equal(result.agents[0].attempt, 3)
  assert.equal(result.agents[0].executionId, "run-to:0:3")
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

test("onSessionCreated 在 running 态回填 sessionId 并触发 onAgentUpdate（F-20）", async () => {
  const updates: Array<{ status: string; sessionId?: string }> = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      // 模拟 adapter：建会话后立即回传；execution.sessionId 与建会话 ID 同源（真实 adapter 行为）
      options?.onSessionCreated?.(`sess-${prompt}`)
      return textResult(`echo:${prompt}`, `sess-${prompt}`)
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'sessionid' }
return await agent('task-a')`,
    {
      agent: runner,
      onAgentUpdate: (record) => updates.push({ status: record.status, sessionId: record.sessionId }),
    },
  )
  // running 态就有 sessionId（TUI 可在运行中进入子会话围观），终态记录同样保留
  assert.deepEqual(updates, [
    { status: "running", sessionId: undefined },
    { status: "running", sessionId: "sess-task-a" },
    { status: "ok", sessionId: "sess-task-a" },
  ])
  assert.equal(result.agents[0].sessionId, "sess-task-a")
})

// ---- Node Inspector（FR-1~FR-7）----

test("executionId 形态与 record 元数据：runId:callIndex:attempt + outputType/preview", async () => {
  const { runner } = countingAgent()
  const result = await runWorkflow(
    `export const meta = { name: 'exec_meta' }
return await agent('任务A')`,
    { agent: runner, runId: "run-exec" },
  )
  const record = result.agents[0]
  assert.equal(record.executionId, "run-exec:0:1")
  assert.equal(record.attempt, 1)
  assert.equal(record.outputType, "text")
  assert.equal(record.outputPreview, "echo:任务A")
  assert.equal(record.inputTokens, 10)
  assert.equal(record.outputTokens, 5)
})

test("retry 成功后 attempt 与 executionId 反映最后一次尝试", async () => {
  let attempts = 0
  const runner: AgentSessionRunner = {
    async run() {
      attempts++
      if (attempts === 1) throw new Error("第一次失败")
      return textResult("ok")
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'exec_retry' }
return await agent('任务')`,
    { agent: runner, agentRetries: 2, runId: "run-retry" },
  )
  assert.equal(result.result, "ok")
  assert.equal(result.agents[0].attempt, 2)
  assert.equal(result.agents[0].executionId, "run-retry:0:2")
})

test("onAgentJournal 载荷携带 Node Inspector 展示元数据", async () => {
  const journals: Array<Record<string, unknown>> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      options?.onUsage?.({ input: 30, output: 20, total: 50 })
      return textResult("hello", "sess-x")
    },
  }
  await runWorkflow(
    `export const meta = { name: 'journal_meta' }
return await agent('提示词', { label: '带名' , agentType: 'general' })`,
    { agent: runner, runId: "run-jm", onAgentJournal: (entry) => journals.push(entry as unknown as Record<string, unknown>) },
  )
  assert.equal(journals.length, 1)
  const payload = journals[0]
  assert.equal(payload.key, "run-jm:0")
  assert.equal(payload.label, "带名")
  assert.equal(payload.agentType, "general")
  assert.equal(payload.sessionId, "sess-x")
  assert.equal(payload.outputType, "text")
  assert.equal(payload.executionId, "run-jm:0:1")
  assert.equal(payload.attempt, 1)
  assert.equal(typeof payload.prompt, "string")
  assert.deepEqual(payload.usage, { inputTokens: 30, outputTokens: 20 })
})

test("onAgentExecution 在失败 attempt 发射；成功 attempt 不发射", async () => {
  const executions: Array<{ key: string; execution: { executionId: string; status: string; error?: string } }> = []
  let attempts = 0
  const runner: AgentSessionRunner = {
    async run() {
      attempts++
      if (attempts === 1) throw new Error("可恢复失败")
      return textResult("ok")
    },
  }
  await runWorkflow(
    `export const meta = { name: 'exec_emit' }
return await agent('任务')`,
    {
      agent: runner,
      agentRetries: 1,
      runId: "run-ee",
      onAgentExecution: (payload) =>
        executions.push(payload as { key: string; execution: { executionId: string; status: string; error?: string } }),
    },
  )
  assert.equal(executions.length, 1)
  assert.equal(executions[0].key, "run-ee:0")
  assert.equal(executions[0].execution.executionId, "run-ee:0:1")
  assert.equal(executions[0].execution.status, "failed")
  assert.equal(executions[0].execution.error, "可恢复失败")
})

test("outputPreview 超 2KB 被截断且敏感键被脱敏", async () => {
  const secret = { api_key: "sk-should-not-leak", nested: { password: "p@ss", safe: "可见" } }
  const runner: AgentSessionRunner = {
    async run() {
      return structuredResult({ ...secret, filler: "x".repeat(5000) })
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'preview_trunc' }
return await agent('任务')`,
    { agent: runner },
  )
  const preview = result.agents[0].outputPreview ?? ""
  assert.ok(preview.length > 0)
  assert.ok(Buffer.byteLength(preview, "utf8") <= 2048)
  assert.ok(!preview.includes("sk-should-not-leak"))
  assert.ok(!preview.includes("p@ss"))
  assert.ok(preview.includes("[REDACTED]"))
  // journal 原值不受脱敏影响（脚本拿到的还是原值）
  const raw = result.result as { api_key: string; nested: { safe: string } }
  assert.deepEqual(raw.nested.safe, "可见")
  assert.equal(raw.api_key, "sk-should-not-leak")
})

test("resume 回放恢复 executionId/outputType；老 journal 无新字段时容忍", async () => {
  const script = `export const meta = { name: 'resume_rich' }
return await agent('任务')`
  // 第一轮：生成新格式 journal（含 executionId/outputType 等展示字段）
  const first = countingAgent()
  const journal = new Map<string, import("../src/types/index.js").JournalEntry>()
  await runWorkflow(script, {
    agent: first.runner,
    runId: "run-r",
    onAgentJournal: (entry) => journal.set(entry.key, entry),
  })
  // 新格式 resume：恢复新字段，不再调 runner
  const second = countingAgent()
  const result2 = await runWorkflow(script, { agent: second.runner, runId: "run-r", resumeJournal: journal })
  assert.equal(second.calls.length, 0)
  assert.equal(result2.agents[0].executionId, "run-r:0:1")
  assert.equal(result2.agents[0].attempt, 1)
  assert.equal(result2.agents[0].outputType, "text")
  // 老格式（剥掉新字段，仅 hash/result/model）：仍可回放，新字段 undefined 不报错
  const rich = journal.get("run-r:0")!
  const legacy = new Map([
    ["run-r:0", { hash: rich.hash, result: rich.result, model: rich.model }],
  ])
  const third = countingAgent()
  const result3 = await runWorkflow(script, { agent: third.runner, runId: "run-r", resumeJournal: legacy })
  assert.equal(third.calls.length, 0)
  assert.equal(result3.result, "echo:任务")
  assert.equal(result3.agents[0].executionId, undefined)
  assert.equal(result3.agents[0].outputType, undefined)
})
