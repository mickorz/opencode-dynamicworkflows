/**
 * ScheduleRun Record（P1 最小版）
 *
 * .opencode-workflows/runs/schedules/<scheduleId>/<epoch>-<status>.json
 *  - fresh session 不 prompt 回传后，这是唯一的结果留档与 lastRun 数据源
 *  - 文件名前缀用 startedAt epoch，天然按时间排序（latestRecord 取最大）
 */

import fs from "node:fs"
import path from "node:path"
import type { ScheduleRun } from "./types.js"

export function recordsRoot(directory: string): string {
  return path.join(directory, ".opencode-workflows", "runs", "schedules")
}

function recordDir(directory: string, scheduleId: string): string {
  return path.join(recordsRoot(directory), scheduleId)
}

/** 写入一条 Record（终态覆盖：同 startedAt 的 running Record 被 rename 覆盖为终态） */
export function writeRecord(directory: string, record: ScheduleRun): void {
  const dir = recordDir(directory, record.scheduleId)
  fs.mkdirSync(dir, { recursive: true })
  const base = record.startedAt // ISO 串含 ":"，转 epoch 存文件名
  const epoch = new Date(base).getTime()
  const filePath = path.join(dir, `${epoch}-${record.status}.json`)
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf-8")
  // 同轮的 running 记录清理：同前缀不同 status 的旧文件删除（先写终态再删 running，中断不丢档）
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${epoch}-`) && file !== path.basename(filePath)) {
      fs.rmSync(path.join(dir, file))
    }
  }
}

/** 读某 schedule 最近一条 Record（按文件名 epoch 排序取最大）；无记录返回 undefined */
export function latestRecord(directory: string, scheduleId: string): ScheduleRun | undefined {
  const dir = recordDir(directory, scheduleId)
  if (!fs.existsSync(dir)) return undefined
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  if (files.length === 0) return undefined
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), "utf-8")) as ScheduleRun
}

/** 读某 schedule 的历史 Record（新在前） */
export function listRecords(directory: string, scheduleId: string, limit = 20): ScheduleRun[] {
  const dir = recordDir(directory, scheduleId)
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit)
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ScheduleRun)
}
