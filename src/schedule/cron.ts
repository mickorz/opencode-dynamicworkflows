// cron 子集校验与 slot 计算（P1）
//
// 支持的四模式（覆盖 /schedule 第一版全部自然语言场景）：
//   每 n 分钟（1-59）  → 分字段为 星/n，其余为星
//   每小时 m 分        → m 星 星 星 星
//   每天 h 点 m 分     → m h 星 星 星
//   每周 W 的 h 点 m 分 → m h 星 星 W（W 为 0-6 单值或逗号列表，0=周日）
//
// slot 计算：cron-parser 本地时区；同一 cron 与同一时刻，各实例算出的 slot 相同
// （TriggerClaim 的 key 一致性前提）。

import { CronExpressionParser } from "cron-parser"

/** 四模式正则；捕获组用于范围校验 */
const EVERY_MINUTES = /^\*\/(\d{1,2}) \* \* \* \*$/
const HOURLY = /^(\d{1,2}) \* \* \* \*$/
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/
const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* (\d(?:,\d)*)$/

/**
 * 校验 cron 是否属于支持的四模式子集。
 * 合法返回 null；非法返回可直接展示的错误信息（含支持格式说明）。
 */
export function validateCron(expr: string): string | null {
  const text = expr.trim()
  if (text !== expr || text.length === 0) return "cron 表达式为空或含首尾空白"

  let m = EVERY_MINUTES.exec(text)
  if (m) {
    const n = Number(m[1])
    if (n < 1 || n > 59) return `每分钟模式的步长需在 1-59 之间，收到 ${n}`
    return null
  }
  m = HOURLY.exec(text)
  if (m) {
    const min = Number(m[1])
    if (min > 59) return `分钟需在 0-59 之间，收到 ${min}`
    return null
  }
  m = DAILY.exec(text)
  if (m) {
    const min = Number(m[1])
    const hour = Number(m[2])
    if (min > 59) return `分钟需在 0-59 之间，收到 ${min}`
    if (hour > 23) return `小时需在 0-23 之间，收到 ${hour}`
    return null
  }
  m = WEEKLY.exec(text)
  if (m) {
    const min = Number(m[1])
    const hour = Number(m[2])
    if (min > 59) return `分钟需在 0-59 之间，收到 ${min}`
    if (hour > 23) return `小时需在 0-23 之间，收到 ${hour}`
    for (const day of m[3].split(",")) {
      const d = Number(day)
      if (d > 6) return `星期需在 0-6 之间（0=周日），收到 ${day}`
    }
    return null
  }

  return [
    `不支持的 cron 表达式 "${expr}"。P1 仅支持四种模式：`,
    "  */n * * * *   每 n 分钟（如 */5 每 5 分钟）",
    "  m  *  * * *   每小时 m 分（如 30 * * * * 每小时半点）",
    "  m  h  * * *   每天 h 点 m 分（如 0 9 * * * 每天 9 点）",
    "  m  h  * * W   每周 W 的 h 点 m 分（W 0-6，0=周日；如 0 10 * * 1 每周一 10 点）",
  ].join("\n")
}

/** 解析并返回 iterator（已通过子集校验的表达式才调用） */
function iterator(cron: string, currentDate: Date) {
  return CronExpressionParser.parse(cron, { currentDate })
}

/** after 之后的下一个未来 slot */
export function nextRun(cron: string, after: Date): Date {
  return iterator(cron, after).next().toDate()
}

/** now 之前（含恰好等于）最近的一个过去 slot；用 prev() 一步回退，无迭代成本 */
export function latestSlot(cron: string, now: Date): Date {
  return iterator(cron, now).prev().toDate()
}
