/**
 * Schedule Reliability 测试（P1 Phase 3）
 * 覆盖：execution lock（占用 skip / 僵尸覆盖 / run 结束释放）/
 *       timeout abort / checkpoint 即败（INTERACTIVE_ACTION_REQUIRED）/
 *       Record 终态字段（trigger/tokens/durationMs）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { ScheduleRuntime } from "../src/schedule/runtime.js"
import { BackgroundRunManager } from "../src/tools/background-runs.js"
import { saveSchedule } from "../src/schedule/store.js"
import { workflowsDir } from "../src/schedule/registry.js"
import { latestRecord } from "../src/schedule/record.js"
import { acquireExecutionLock, releaseExecutionLock, executionLocksDir } from "../src/schedule/coordination.js"
import type { Schedule } from "../src/schedule/types.js"

type Client = PluginInput["client"]

interface FakeClientOptions {
  /** 子会话 prompt 挂起（block 模式：长任务/timeout 测试用） */
  blockChildren?: boolean
  /** 手动释放挂起会话的回调 */
  release?: () => void
}

function makeFakeClient(opts: FakeClientOptions = {}) {
  let seq = 0
  const prompts: string[] = []
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  const client = {
    session: {
      create: async () => ({ data: { id: `sess-${++seq}` }, error: undefined }),
      prompt: (input: { body: { parts: Array<{ type: string; text?: string }> } }) => {
        const text = input.body.parts.map((p) => p.text ?? "").join("")
        prompts.push(text)
        if (opts.blockChildren) {
          return new Promise((resolve, reject) => {
            pending.push({
              resolve: () =>
                resolve({
                  data: { info: { tokens: { input: 3, output: 4 } }, parts: [{ type: "text", text: "ok" }] },
                  error: undefined,
                }),
              reject: () => reject(new Error("aborted")),
            })
          })
        }
        return Promise.resolve({
          data: { info: { tokens: { input: 3, output: 4 } }, parts: [{ type: "text", text: "ok" }] },
          error: undefined,
        })
      },
      abort: async () => {
        // abort 解除全部挂起 prompt（模拟真实 server abort：请求 reject）
        pending.splice(0).forEach((entry) => entry.reject(new Error("aborted")))
        return { data: undefined, error: undefined }
      },
    },
  }
  return {
    client: client as unknown as Client,
    prompts,
    releaseAll: () => pending.splice(0).forEach((entry) => entry.resolve()),
  }
}

function makeProject(workflowBody = "return await agent('定时任务')"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rel-"))
  fs.mkdirSync(workflowsDir(dir), { recursive: true })
  fs.writeFileSync(
    path.join(workflowsDir(dir), "demo.js"),
    `export const meta = { name: 'demo' }\n${workflowBody}\n`,
  )
  return dir
}

function putSchedule(dir: string, overrides: Partial<Schedule> = {}): Schedule {
  const schedule: Schedule = {
    id: "sch-demo",
    workflowId: "demo",
    cron: "*/1 * * * *",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  saveSchedule(dir, schedule)
  return schedule
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ---------- execution lock ----------

test("execution lock：占用时 run_now 返回错误并写 skipped Record", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    // 预占锁（模拟另一实例正在跑同 schedule）
    assert.equal(acquireExecutionLock(dir, "sch-demo"), true)
    const runtime = new ScheduleRuntime({ client: makeFakeClient().client, directory: dir, manager: new BackgroundRunManager() })
    const result = await runtime.runNow("sch-demo")
    assert.match(result.error ?? "", /启动失败/)
    await until(() => latestRecord(dir, "sch-demo")?.status === "skipped", 3000)
    const record = latestRecord(dir, "sch-demo")
    assert.match(record?.error ?? "", /overlapPolicy=skip/)
    releaseExecutionLock(dir, "sch-demo")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("execution lock：僵尸锁（持有 pid 已死）被覆盖", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    // 手写一个死 pid 的僵尸锁
    fs.mkdirSync(executionLocksDir(dir), { recursive: true })
    fs.writeFileSync(
      path.join(executionLocksDir(dir), "sch-demo.lock"),
      JSON.stringify({ scheduleId: "sch-demo", pid: 999999, startedAt: new Date().toISOString() }),
    )
    const fake = makeFakeClient()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager: new BackgroundRunManager() })
    const result = await runtime.runNow("sch-demo")
    assert.ok(result.runId, "僵尸锁被覆盖，正常启动")
    await until(() => latestRecord(dir, "sch-demo")?.status === "success", 5000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("execution lock：run 结束后释放，下一轮可立即执行", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    const runtime = new ScheduleRuntime({ client: makeFakeClient().client, directory: dir, manager: new BackgroundRunManager() })
    await runtime.runNow("sch-demo")
    await until(() => latestRecord(dir, "sch-demo")?.status === "success", 5000)
    assert.equal(fs.existsSync(path.join(executionLocksDir(dir), "sch-demo.lock")), false, "锁已释放")
    const second = await runtime.runNow("sch-demo")
    assert.ok(second.runId, "第二轮可立即执行")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- timeout ----------

test("timeout：超过 timeoutMs 被 abort，Record 记 timeout 态", async () => {
  const dir = makeProject("return await agent('长任务')")
  try {
    putSchedule(dir, { timeoutMs: 500 })
    const fake = makeFakeClient({ blockChildren: true }) // agent 挂起模拟长任务
    const manager = new BackgroundRunManager()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager })
    await runtime.runNow("sch-demo")
    await until(() => latestRecord(dir, "sch-demo")?.status === "timeout", 8000)
    const record = latestRecord(dir, "sch-demo")
    assert.match(record?.error ?? "", /timeoutMs/)
    assert.equal(fs.existsSync(path.join(executionLocksDir(dir), "sch-demo.lock")), false, "超时后锁也释放")
    fake.releaseAll()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- checkpoint 即败 ----------

test("checkpoint 即败：scheduled run 中 checkpoint 抛 INTERACTIVE_ACTION_REQUIRED，Record failed", async () => {
  const dir = makeProject("return await checkpoint('需要确认', { headless: 'abort' }) ? 'ok' : 'no'")
  try {
    putSchedule(dir)
    const runtime = new ScheduleRuntime({ client: makeFakeClient().client, directory: dir, manager: new BackgroundRunManager() })
    await runtime.runNow("sch-demo")
    await until(() => latestRecord(dir, "sch-demo")?.status === "failed", 8000)
    const record = latestRecord(dir, "sch-demo")
    // confirm 注入优先于脚本内 headless 选项：错误信息应含 INTERACTIVE_ACTION_REQUIRED
    assert.match(record?.error ?? "", /INTERACTIVE_ACTION_REQUIRED/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- Record 终态字段 ----------

test("Record 终态字段：trigger / slotEpoch / tokens / durationMs", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    const runtime = new ScheduleRuntime({ client: makeFakeClient().client, directory: dir, manager: new BackgroundRunManager() })
    await runtime.runNow("sch-demo")
    await until(() => latestRecord(dir, "sch-demo")?.status === "success", 5000)
    const record = latestRecord(dir, "sch-demo")
    assert.equal(record?.trigger, "manual", "run_now 记 manual")
    assert.ok(record?.slotEpoch && record.slotEpoch > 0)
    assert.ok(record?.durationMs !== undefined && record.durationMs >= 0)
    assert.ok(record?.tokens !== undefined && record.tokens >= 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
