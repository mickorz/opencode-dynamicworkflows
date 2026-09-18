/**
 * Schedule 领域层测试（P1 Phase 1）
 * 覆盖：cron 四模式校验与 slot 计算 / store CRUD / registry 扫描 / service create 与 list 视图
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateCron, nextRun, latestSlot } from "../src/schedule/cron.js"
import { loadRegistry, readWorkflowScript, workflowsDir } from "../src/runtime/workflow-registry.js"
import { saveSchedule, listSchedules, getSchedule } from "../src/schedule/store.js"
import { createSchedule, listScheduleViews } from "../src/schedule/service.js"
import { writeRecord, latestRecord } from "../src/schedule/record.js"
import type { Schedule } from "../src/schedule/types.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-sch-"))
}

// ---------- cron ----------

test("cron 四模式合法校验", () => {
  assert.equal(validateCron("*/5 * * * *"), null)
  assert.equal(validateCron("* * * * *"), null, "裸星号即每分钟（与 */1 等价）")
  assert.equal(validateCron("30 * * * *"), null)
  assert.equal(validateCron("0 9 * * *"), null)
  assert.equal(validateCron("0 10 * * 1"), null)
  assert.equal(validateCron("0 10 * * 1,3,5"), null)
})

test("cron 非法输入给出含格式说明的错误", () => {
  const cases = ["", "0 9 * *", "*/60 * * * *", "60 * * * *", "0 24 * * *", "0 9 * * 7", "15 10 1 * *", "0 9-17 * * *", " 0 9 * * *"]
  for (const expr of cases) {
    const err = validateCron(expr)
    assert.ok(err !== null, `"${expr}" 应被拒绝`)
    assert.match(err, /支持|之间|为空/, `错误信息应可指导用户：${err}`)
  }
})

test("nextRun 与 latestSlot 边界", () => {
  // 每 5 分钟：15:37:12 -> next 15:40 / latest 15:35
  const now = new Date(2026, 8, 17, 15, 37, 12)
  assert.equal(nextRun("*/5 * * * *", now).getTime(), new Date(2026, 8, 17, 15, 40, 0).getTime())
  assert.equal(latestSlot("*/5 * * * *", now).getTime(), new Date(2026, 8, 17, 15, 35, 0).getTime())
  // 裸星号与 */1 结果一致（每分钟）
  assert.equal(nextRun("* * * * *", now).getTime(), nextRun("*/1 * * * *", now).getTime())
  assert.equal(latestSlot("* * * * *", now).getTime(), latestSlot("*/1 * * * *", now).getTime())
  // 每天 9 点：08:59 -> latest 是昨天 9 点
  const morning = new Date(2026, 8, 17, 8, 59, 10)
  assert.equal(latestSlot("0 9 * * *", morning).getTime(), new Date(2026, 8, 16, 9, 0, 0).getTime())
  // cron-parser prev() 严格小于：恰好 09:00:00.000 的瞬间返回昨天（下个 30s tick 即正常认领今天，无实际影响）
  const exact = new Date(2026, 8, 17, 9, 0, 0)
  assert.equal(latestSlot("0 9 * * *", exact).getTime(), new Date(2026, 8, 16, 9, 0, 0).getTime())
})

// ---------- registry ----------

test("registry：meta.id 优先，缺省回落 name；重复 id 报错", () => {
  const dir = tmpProject()
  fs.mkdirSync(workflowsDir(dir), { recursive: true })
  fs.writeFileSync(path.join(workflowsDir(dir), "a.js"), `export const meta = { id: 'daily-review', name: 'Daily' }\nreturn 1\n`)
  fs.writeFileSync(path.join(workflowsDir(dir), "b.js"), `export const meta = { name: 'nightly' }\nreturn 2\n`)
  const registry = loadRegistry(dir)
  assert.ok(registry.has("daily-review"), "meta.id 作为 workflowId")
  assert.ok(registry.has("nightly"), "缺省回落 meta.name")
  assert.match(readWorkflowScript(dir, "nightly"), /return 2/)
  assert.throws(() => readWorkflowScript(dir, "nope"), /WORKFLOW_NOT_FOUND/)

  fs.writeFileSync(path.join(workflowsDir(dir), "c.js"), `export const meta = { name: 'nightly' }\nreturn 3\n`)
  assert.throws(() => loadRegistry(dir), /重复/)
})

test("registry：非法脚本带文件名上抛（不做防御跳过）", () => {
  const dir = tmpProject()
  fs.mkdirSync(workflowsDir(dir), { recursive: true })
  fs.writeFileSync(path.join(workflowsDir(dir), "bad.js"), `没有 meta 的脚本\n`)
  assert.throws(() => loadRegistry(dir), /bad\.js/)
})

// ---------- store ----------

test("store：save/list/get 原子落盘", () => {
  const dir = tmpProject()
  assert.deepEqual(listSchedules(dir), [], "目录不存在返回空")
  const schedule: Schedule = {
    id: "sch-demo",
    workflowId: "demo",
    cron: "0 9 * * *",
    enabled: true,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  }
  saveSchedule(dir, schedule)
  assert.equal(getSchedule(dir, "sch-demo")?.cron, "0 9 * * *")
  assert.equal(listSchedules(dir).length, 1)
})

// ---------- service ----------

test("service.create：非法 cron / 未知 workflow / 成功路径", () => {
  const dir = tmpProject()
  fs.mkdirSync(workflowsDir(dir), { recursive: true })
  fs.writeFileSync(path.join(workflowsDir(dir), "demo.js"), `export const meta = { name: 'demo' }\nreturn 1\n`)

  assert.throws(() => createSchedule({ directory: dir, workflowId: "demo", cron: "60 * * * *" }), /INVALID_CRON/)
  assert.throws(() => createSchedule({ directory: dir, workflowId: "ghost", cron: "0 9 * * *" }), /WORKFLOW_NOT_FOUND/)

  const created = createSchedule({ directory: dir, workflowId: "demo", cron: "*/5 * * * *", name: "演示" })
  assert.match(created.id, /^sch-demo-/)
  assert.equal(created.enabled, true)

  const views = listScheduleViews(dir)
  assert.equal(views.length, 1)
  assert.ok(views[0].nextRunAt, "视图含 nextRun")
  assert.equal(views[0].lastRunStatus, undefined, "无执行历史")
  assert.equal(views[0].workflowMissing, false)

  // workflow 被删后视图标 missing
  fs.rmSync(path.join(workflowsDir(dir), "demo.js"))
  assert.equal(listScheduleViews(dir)[0].workflowMissing, true)
})

test("service 视图聚合 lastRun（来自 Record）", () => {
  const dir = tmpProject()
  writeRecord(dir, {
    scheduleId: "sch-x",
    workflowId: "demo",
    status: "success",
    startedAt: "2026-09-17T09:00:02.000Z",
    finishedAt: "2026-09-17T09:01:00.000Z",
    result: "完成：1/1 agent 成功",
  })
  const record = latestRecord(dir, "sch-x")
  assert.equal(record?.status, "success")
  assert.match(record?.result ?? "", /1\/1/)
})
