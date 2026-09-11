/**
 * setConcurrency 动态并发测试（需求：动态并发控制 方案 A）
 *
 * 覆盖：
 *  - semaphore setLimit：调大立即唤醒排队者；调小不抢占存量
 *  - setConcurrency 非法值报错、超 16 钳制并记日志
 *  - run 内调 setConcurrency 后实际并发随之变化（gatedAgent 实测 maxActive）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createLimiter } from "../src/runtime/semaphore.js"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import { WorkflowError } from "../src/runtime/errors.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import { textResult } from "./helpers.js"

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 门控任务工厂：任务启动后阻塞，直到手动放行 */
function gatedTasks(limiter: ReturnType<typeof createLimiter>) {
  const started: number[] = []
  const gates = new Map<number, () => void>()
  const task = (n: number) =>
    limiter(
      () =>
        new Promise<void>((resolve) => {
          started.push(n)
          gates.set(n, resolve)
        }),
    )
  return { task, started, release: (n: number) => gates.get(n)?.(), releaseAll: () => gates.forEach((r) => r()) }
}

test("setLimit 调大立即唤醒排队者", async () => {
  const limiter = createLimiter(1)
  const { task, started, releaseAll } = gatedTasks(limiter)
  const ps = [task(1), task(2), task(3)]
  await tick()
  assert.deepEqual(started, [1], "初始上限 1：只有任务 1 在跑")
  limiter.setLimit(3)
  await tick()
  assert.deepEqual(started, [1, 2, 3], "调大后排队者立即被唤醒")
  releaseAll()
  await Promise.all(ps)
})

test("setLimit 调小不抢占存量", async () => {
  const limiter = createLimiter(2)
  const { task, started, release } = gatedTasks(limiter)
  const p1 = task(1)
  const p2 = task(2)
  await tick()
  assert.deepEqual(started, [1, 2])
  limiter.setLimit(1)
  const p3 = task(3)
  await tick()
  assert.deepEqual(started, [1, 2], "调小后新任务排队，不中断存量")
  release(1)
  await tick()
  assert.deepEqual(started, [1, 2, 3], "存量释放一个后排队任务才入场")
  release(2)
  release(3)
  await Promise.all([p1, p2, p3])
})

test("setConcurrency 非法值报错", async () => {
  for (const bad of [0, -1, 1.5, "4", null]) {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 't', description: 'd' }\nsetConcurrency(${JSON.stringify(bad)})\nawait agent('hi')\n`,
        { agent: countingAgent() },
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError, `期望 WorkflowError，收到 ${String(bad)}`)
        assert.match(error.message, /setConcurrency 需要正整数/)
        return true
      },
    )
  }
})

test("setConcurrency 超 16 钳到 16 并记日志", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 't', description: 'd' }\nsetConcurrency(100)\nawait agent('hi')\n`,
    { agent: countingAgent(), concurrency: 2 },
  )
  assert.ok(result.logs.some((line) => line.includes("并发上限调整为 16（原 2）")), JSON.stringify(result.logs))
})

test("run 内 setConcurrency 后实际并发随之变化", async () => {
  const gated = gatedAgent()
  const runPromise = runWorkflow(
    `export const meta = { name: 't', description: 'd' }\n` +
      `setConcurrency(3)\n` +
      `await parallel([() => agent('a'), () => agent('b'), () => agent('c'), () => agent('d')])\n`,
    { agent: gated.runner, concurrency: 1 },
  )
  // 初始并发 1，脚本调 setConcurrency(3) 后应同时有 3 个在跑
  for (let i = 0; i < 100 && gated.maxActive() < 3; i++) await tick()
  assert.equal(gated.maxActive(), 3, `期望动态并发后 maxActive=3，实际 ${gated.maxActive()}`)
  // 逐轮放行直到结束（后续准入的 agent 也要有人开门）
  let result: Awaited<ReturnType<typeof runWorkflow>> | undefined
  for (let i = 0; i < 200 && result === undefined; i++) {
    gated.releaseAll()
    result = await Promise.race([runPromise, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5))])
  }
  if (result === undefined) result = await runPromise
  assert.ok(result.logs.some((line) => line.includes("并发上限调整为 3（原 1）")), JSON.stringify(result.logs))
})

/** 计数 fake：回显 prompt */
function countingAgent(): AgentSessionRunner {
  return {
    async run(prompt) {
      return textResult(`echo:${prompt}`)
    },
  }
}

/** 可放行的 fake：统计同时在跑的最大数 */
function gatedAgent() {
  let active = 0
  let max = 0
  const gates: Array<() => void> = []
  const runner: AgentSessionRunner = {
    run() {
      active++
      max = Math.max(max, active)
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
    maxActive: () => max,
  }
}
