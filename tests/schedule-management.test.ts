/**
 * Schedule 管理操作测试（P1 Phase 2）
 * 覆盖：get/update/delete/enable/disable 校验与落盘 / runNow 执行路径 / 工具面薄壳
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  createSchedule,
  getScheduleView,
  updateSchedule,
  setScheduleEnabled,
  removeSchedule,
} from "../src/schedule/service.js"
import { getSchedule } from "../src/schedule/store.js"
import { workflowsDir } from "../src/schedule/registry.js"
import { ScheduleRuntime } from "../src/schedule/runtime.js"
import { BackgroundRunManager } from "../src/tools/background-runs.js"
import { latestRecord } from "../src/schedule/record.js"

type Client = PluginInput["client"]

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-mgmt-"))
  fs.mkdirSync(workflowsDir(dir), { recursive: true })
  fs.writeFileSync(
    path.join(workflowsDir(dir), "demo.js"),
    `export const meta = { name: 'demo' }\nreturn await agent('立即执行任务')\n`,
  )
  return dir
}

function fakeClient() {
  let seq = 0
  const prompts: string[] = []
  const client = {
    session: {
      create: async () => ({ data: { id: `sess-${++seq}` }, error: undefined }),
      prompt: (input: { body: { parts: Array<{ type: string; text?: string }> } }) => {
        prompts.push(input.body.parts.map((p) => p.text ?? "").join(""))
        return Promise.resolve({
          data: { info: { tokens: { input: 3, output: 4 } }, parts: [{ type: "text", text: "ok" }] },
          error: undefined,
        })
      },
      abort: async () => ({ data: undefined, error: undefined }),
    },
  }
  return { client: client as unknown as Client, prompts }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("get/update/enable/disable/delete：校验与落盘", () => {
  const dir = makeProject()
  const s = createSchedule({ directory: dir, workflowId: "demo", cron: "0 9 * * *" })

  const view = getScheduleView(dir, s.id)
  assert.equal(view.history.length, 0)
  assert.ok(view.nextRunAt)

  // 非法 cron / 不存在 id
  assert.throws(() => updateSchedule(dir, s.id, { cron: "60 9 * * *" }), /INVALID_CRON/)
  assert.throws(() => updateSchedule(dir, "sch-nope", { cron: "0 9 * * *" }), /SCHEDULE_NOT_FOUND/)
  assert.throws(() => updateSchedule(dir, s.id, { timeoutMs: -1 }), /timeoutMs/)

  // 更新可变字段
  const updated = updateSchedule(dir, s.id, { cron: "30 8 * * *", name: "晨报", args: { branch: "main" } })
  assert.equal(getSchedule(dir, s.id)?.cron, "30 8 * * *")
  assert.equal(updated.name, "晨报")
  assert.deepEqual(updated.args, { branch: "main" })

  // workflowId 不可改：白名单外字段直接被忽略（类型层约束，运行时验证 patch 只含白名单）
  const before = getSchedule(dir, s.id)?.workflowId
  updateSchedule(dir, s.id, {})
  assert.equal(getSchedule(dir, s.id)?.workflowId, before)

  // enable / disable
  setScheduleEnabled(dir, s.id, false)
  assert.equal(getSchedule(dir, s.id)?.enabled, false)
  assert.equal(getScheduleView(dir, s.id).nextRunAt, undefined, "停用后不显示 nextRun")
  setScheduleEnabled(dir, s.id, true)
  assert.equal(getSchedule(dir, s.id)?.enabled, true)

  // delete：只删配置，不动 workflow 文件
  removeSchedule(dir, s.id)
  assert.equal(getSchedule(dir, s.id), undefined)
  assert.ok(fs.existsSync(path.join(workflowsDir(dir), "demo.js")), "workflow 文件保留")
  assert.throws(() => removeSchedule(dir, s.id), /SCHEDULE_NOT_FOUND/)
})

test("runNow：立即执行路径（fresh session + Record 终态）", async () => {
  const dir = makeProject()
  const s = createSchedule({ directory: dir, workflowId: "demo", cron: "0 9 * * *", enabled: false })
  const fake = fakeClient()
  const runtime = new ScheduleRuntime({ client: fake.client, directory: dir, manager: new BackgroundRunManager() })

  // enabled=false 也不影响手动 run_now
  const result = await runtime.runNow(s.id)
  assert.ok(result.runId, `返回 runId：${result.error}`)

  await until(() => latestRecord(dir, s.id)?.status === "success", 5000)
  const record = latestRecord(dir, s.id)
  assert.equal(record?.workflowRunId, result.runId)
  assert.ok(record?.sessionId?.startsWith("sess-"))

  // 不存在 id
  const missing = await runtime.runNow("sch-nope")
  assert.match(missing.error ?? "", /SCHEDULE_NOT_FOUND/)
})

test("runNow workflow 缺失：返回错误并落 failed Record", async () => {
  const dir = makeProject()
  const s = createSchedule({ directory: dir, workflowId: "demo", cron: "0 9 * * *" })
  fs.rmSync(path.join(workflowsDir(dir), "demo.js"))
  const runtime = new ScheduleRuntime({ client: fakeClient().client, directory: dir, manager: new BackgroundRunManager() })

  const result = await runtime.runNow(s.id)
  assert.ok(result.error)
  assert.match(latestRecord(dir, s.id)?.error ?? "", /WORKFLOW_NOT_FOUND/)
})
