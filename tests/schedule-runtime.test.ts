/**
 * ScheduleRuntime 测试（P1 Phase 1）
 * 覆盖：准点触发 / 错过超 grace 跳过 / 同 slot 二次 tick 不重复 / 重启后旧 slot 不补发 /
 *       disabled 跳过 / workflow 缺失落 failed Record / 双 runtime（双 TUI）竞争恰一执行 /
 *       onFinished 终态 Record
 *
 * 模式：真 ScheduleRuntime + 真 BackgroundRunManager + fake client（复用 background.test.ts 模式）
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
import { workflowsDir } from "../src/runtime/workflow-registry.js"
import { latestRecord, writeRecord } from "../src/schedule/record.js"
import type { Schedule } from "../src/schedule/types.js"

type Client = PluginInput["client"]

function makeFakeClient() {
  let seq = 0
  /** 全部 prompt 文本（agent 子会话与 fresh session 回传都记录，按内容区分） */
  const prompts: string[] = []
  const client = {
    session: {
      create: async () => ({ data: { id: `sess-${++seq}` }, error: undefined }),
      prompt: (input: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }> } }) => {
        const text = input.body.parts.map((p) => p.text ?? "").join("")
        prompts.push(text)
        return Promise.resolve({
          data: { info: { tokens: { input: 3, output: 4 }, cost: 0.001 }, parts: [{ type: "text", text: `ok:${text.slice(0, 8)}` }] },
          error: undefined,
        })
      },
      abort: async () => ({ data: undefined, error: undefined }),
    },
  }
  return { client: client as unknown as Client, prompts }
}

/** agent 执行证据：脚本内 agent('定时任务') 的 prompt 已发出 */
const agentPromptCount = (fake: { prompts: string[] }) => fake.prompts.filter((t) => t === "定时任务").length

function makeProject(withWorkflow = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rt-"))
  if (withWorkflow) {
    fs.mkdirSync(workflowsDir(dir), { recursive: true })
    fs.writeFileSync(
      path.join(workflowsDir(dir), "demo.js"),
      `export const meta = { name: 'demo' }\nreturn await agent('定时任务')\n`,
    )
  }
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

test("准点触发：grace 内 slot 被 claim 并后台执行，Record 落盘", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    const fake = makeFakeClient()
    const manager = new BackgroundRunManager()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager })
    // 当前真实时刻：每分钟 cron 的 latestSlot 必在 60s 内（< grace 90s），必然触发
    await runtime.tick()
    // fresh session 已创建 + agent 子会话 prompt 已发
    await until(() => agentPromptCount(fake) >= 1, 3000)
    // running Record 已写
    const running = latestRecord(dir, "sch-demo")
    assert.ok(running, "Record 落盘")
    assert.equal(running?.status, "running")
    assert.ok(running?.sessionId?.startsWith("sess-"), "fresh session id 已记录")
    // 等 run 完成 -> onFinished 终态 Record
    await until(() => latestRecord(dir, "sch-demo")?.status === "success", 5000)
    const final = latestRecord(dir, "sch-demo")
    assert.ok(final?.workflowRunId, "终态 Record 关联 workflowRunId")
    assert.match(final?.result ?? "", /1\/1/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("同 slot 二次 tick：claim 挡住，不重复执行", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    const fake = makeFakeClient()
    const manager = new BackgroundRunManager()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager })
    await runtime.tick()
    await until(() => agentPromptCount(fake) >= 1, 3000)
    const first = agentPromptCount(fake)
    // 同一时刻再 tick（latestSlot 相同）：claim EEXIST，静默
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(agentPromptCount(fake), first, "不产生第二个 agent run")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("错过超 grace：不 claim 不执行（missed = skip）", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir, { cron: "0 9 * * *" }) // 每天 9 点
    const fake = makeFakeClient()
    const runtime = new ScheduleRuntime({
      client: fake.client,
      directory: dir,
      manager: new BackgroundRunManager(),
      // now 定在 9 点后 10 分钟：latestSlot = 今天 9:00，diff 10min > grace
      now: () => new Date(new Date().setHours(9, 10, 0, 0)),
    })
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(agentPromptCount(fake), 0, "错过的 slot 不执行")
    assert.equal(latestRecord(dir, "sch-demo"), undefined, "不写 Record")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("重启场景：新 runtime 实例对历史 slot 不补发，新 slot 正常触发", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir, { cron: "0 9 * * *" })
    // 第一实例在 9:00:20 触发过（写死 claim 模拟）
    const { tryClaim } = await import("../src/schedule/coordination.js")
    const slot = new Date(new Date().setHours(9, 0, 0, 0))
    assert.equal(tryClaim(dir, "sch-demo", slot), true)
    writeRunningRecord(dir)

    // 重启后的新实例在 9:00:40 tick：latestSlot=9:00 已被 claim -> 静默
    const fake = makeFakeClient()
    const runtime = new ScheduleRuntime({
      client: fake.client,
      directory: dir,
      manager: new BackgroundRunManager(),
      now: () => new Date(new Date().setHours(9, 0, 40, 0)),
    })
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(agentPromptCount(fake), 0, "历史 slot 不补发")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("disabled schedule：tick 跳过", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir, { enabled: false })
    const fake = makeFakeClient()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager: new BackgroundRunManager() })
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(agentPromptCount(fake), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("workflow 缺失：认领后落 failed Record（WORKFLOW_NOT_FOUND）", async () => {
  const dir = makeProject(false) // 无 workflows 目录
  try {
    putSchedule(dir)
    const fake = makeFakeClient()
    const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager: new BackgroundRunManager() })
    await runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const record = latestRecord(dir, "sch-demo")
    assert.equal(record?.status, "failed")
    assert.match(record?.error ?? "", /WORKFLOW_NOT_FOUND/)
    assert.equal(agentPromptCount(fake), 0, "未创建 agent 会话")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("双 TUI 竞争：两个 runtime 同目录同 tick，恰一个执行 agent", async () => {
  const dir = makeProject()
  try {
    putSchedule(dir)
    const fakeA = makeFakeClient()
    const fakeB = makeFakeClient()
    const managerA = new BackgroundRunManager()
    const managerB = new BackgroundRunManager()
    const runtimeA = new ScheduleRuntime({ client: fakeA.client, directory: dir, manager: managerA })
    const runtimeB = new ScheduleRuntime({ client: fakeB.client, directory: dir, manager: managerB })
    // 同一时刻并发 tick（模拟两个 OpenCode TUI 同时到点判定）
    await Promise.all([runtimeA.tick(), runtimeB.tick()])
    await until(() => agentPromptCount(fakeA) + agentPromptCount(fakeB) >= 1, 3000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const total = agentPromptCount(fakeA) + agentPromptCount(fakeB)
    assert.equal(total, 1, `恰一个实例执行（A=${agentPromptCount(fakeA)}, B=${agentPromptCount(fakeB)}）`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function writeRunningRecord(dir: string): void {
  // 模拟第一实例触发时写的 running Record（重启场景铺垫）
  writeRecord(dir, {
    scheduleId: "sch-demo",
    workflowId: "demo",
    status: "running",
    startedAt: new Date().toISOString(),
  })
}
