/**
 * ScheduleStore（P1）—— schedules/*.json 纯配置存取
 *
 * 约定：
 *  - 文件名 = <scheduleId>.json，内容为 Schedule
 *  - 写入为原子操作（临时文件 + rename），只保证不写坏、不承诺无 Lost Update
 *  - 运行时（tick）只读不写；写方仅 Service（用户操作），无并发写冲突
 */

import fs from "node:fs"
import path from "node:path"
import type { Schedule } from "./types.js"

export function schedulesDir(directory: string): string {
  return path.join(directory, ".opencode-workflows", "schedules")
}

/** 列出全部 schedule（文件损坏/非法时带文件名上抛） */
export function listSchedules(directory: string): Schedule[] {
  const dir = schedulesDir(directory)
  if (!fs.existsSync(dir)) return []
  const result: Schedule[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const filePath = path.join(dir, entry.name)
    try {
      result.push(JSON.parse(fs.readFileSync(filePath, "utf-8")) as Schedule)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`schedules 目录中 ${entry.name} 解析失败：${message}`)
    }
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function getSchedule(directory: string, id: string): Schedule | undefined {
  const filePath = path.join(schedulesDir(directory), `${id}.json`)
  if (!fs.existsSync(filePath)) return undefined
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Schedule
}

/** 原子写入（tmp + rename） */
export function saveSchedule(directory: string, schedule: Schedule): void {
  const dir = schedulesDir(directory)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${schedule.id}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(schedule, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, target)
}

export function deleteScheduleFile(directory: string, id: string): boolean {
  const filePath = path.join(schedulesDir(directory), `${id}.json`)
  if (!fs.existsSync(filePath)) return false
  fs.rmSync(filePath)
  return true
}
