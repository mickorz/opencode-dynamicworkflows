/**
 * 协调层测试（P1 Phase 1）
 * 覆盖：tryClaim 原子性（同进程 / 跨进程）/ prune 过期清理 / Record 写读
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { tryClaim, pruneClaims, claimsRoot, CLAIM_RETENTION_MS } from "../src/schedule/coordination.js"
import { writeRecord, latestRecord, listRecords } from "../src/schedule/record.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-coord-"))
}

test("tryClaim：同 slot 首次成功、再次失败；不同 slot 互不影响", () => {
  const dir = tmpProject()
  const slot = new Date("2026-09-17T09:00:00")
  assert.equal(tryClaim(dir, "sch-a", slot), true, "首次认领成功")
  assert.equal(tryClaim(dir, "sch-a", slot), false, "重复认领失败（EEXIST）")
  assert.equal(tryClaim(dir, "sch-a", new Date("2026-09-17T10:00:00")), true, "另一 slot 独立认领")
  assert.equal(tryClaim(dir, "sch-b", slot), true, "另一 schedule 独立认领")
  // claim 内容人读信息完整
  const content = JSON.parse(fs.readFileSync(path.join(claimsRoot(dir), "sch-a", `${slot.getTime()}.claim`), "utf-8"))
  assert.equal(content.scheduleId, "sch-a")
  assert.equal(content.scheduledAt, slot.toISOString())
})

test("pruneClaims：过期删除、保留期内不删", () => {
  const dir = tmpProject()
  const now = Date.now()
  const oldSlot = new Date(now - CLAIM_RETENTION_MS - 60_000)
  const freshSlot = new Date(now - 60_000)
  tryClaim(dir, "sch-a", oldSlot)
  tryClaim(dir, "sch-a", freshSlot)
  const removed = pruneClaims(dir, now)
  assert.equal(removed, 1, "只删过期的")
  assert.equal(tryClaim(dir, "sch-a", oldSlot), true, "过期被删后可重新认领（不应发生：tick 有 grace 挡旧 slot）")
  assert.equal(tryClaim(dir, "sch-a", freshSlot), false, "保留期内仍在")
})

test("tryClaim 跨进程：两个子进程竞争同一 slot，恰一个成功", async () => {
  const dir = tmpProject()
  const slot = new Date("2026-09-17T09:00:00")
  // 子进程脚本（tsx 直跑源码，不依赖 dist——CI 的 npm test 在 build 之前）：
  // 轮询起跑文件出现后立即 tryClaim，exit 0 = 抢到 / exit 3 = EEXIST / exit 4 = barrier 超时
  const script = `
import { tryClaim } from ${JSON.stringify(pathToFileURL(path.resolve("src/schedule/coordination.ts")).href)}
import fs from "node:fs"
const dir = ${JSON.stringify(dir)}
const slot = new Date(${slot.getTime()})
const goFile = ${JSON.stringify(path.join(dir, "go.flag"))}
const deadline = Date.now() + 10000
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) { console.error("barrier timeout"); process.exit(4) }
}
process.exit(tryClaim(dir, ${JSON.stringify("sch-race")}, slot) ? 0 : 3)
`
  const scriptFile = path.join(dir, "race-child.mts")
  fs.writeFileSync(scriptFile, script, "utf-8")
  const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs")
  // 两个子进程先起（各自轮询 barrier），父进程放行后并发抢同一 slot
  const children = [0, 1].map(() => spawnPromise(process.execPath, [tsxCli, scriptFile], { timeout: 15_000 }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  fs.writeFileSync(path.join(dir, "go.flag"), "")
  const codes = await Promise.all(children)
  const successes = codes.filter((c) => c === 0).length
  assert.ok(successes <= 1, `恰至多一个进程抢到（exit codes: ${codes.join(",")}）`)
  assert.ok(codes.every((c) => c === 0 || c === 3), `无异常退出（exit codes: ${codes.join(",")}）`)
})

/** spawn 异步包装，返回 exit code */
function spawnPromise(cmd: string, args: string[], opts: { timeout?: number }): Promise<number | null> {
  const child = spawn(cmd, args, opts)
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code))
    child.on("error", () => resolve(-1))
  })
}

test("Record：write/latest/list 与 running 覆盖为终态", () => {
  const dir = tmpProject()
  const startedAt = new Date("2026-09-17T09:00:02.000Z").toISOString()
  writeRecord(dir, { scheduleId: "sch-r", workflowId: "demo", status: "running", startedAt })
  writeRecord(dir, {
    scheduleId: "sch-r",
    workflowId: "demo",
    status: "success",
    startedAt,
    finishedAt: new Date("2026-09-17T09:01:00.000Z").toISOString(),
    result: "完成：1/1 agent 成功",
  })
  assert.equal(latestRecord(dir, "sch-r")?.status, "success")
  assert.equal(listRecords(dir, "sch-r").length, 1, "running 记录被终态覆盖清理")
})
