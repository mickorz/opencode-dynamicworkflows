/**
 * ResultView —— 节点结果的展示抽象（FR-5，Node Inspector）
 *
 * 职责：text / structured / raw 三种渲染分支、20KB 截断、敏感键脱敏、
 * 空态三分判定（error / pending / empty / content）。
 *
 * 截断与脱敏的实现与 server 侧 src/runtime/agent-result.ts 同语义
 * （跨进程禁止 import server 模块，两处需人工同步）。
 * 脱敏只作用于渲染副本；journal 原值（resume 数据）永不在此修改。
 *
 * 纯 TypeScript 无 solid 依赖，node:test 直接可测。
 */

import type { JournalEntryView } from "./journal-reader.js"
import type { WorkflowNodeStatus } from "./workflow-store.js"

/** 结果正文展示的字节预算（FR-5：超过即截断预览） */
export const RESULT_MAX_BYTES = 20 * 1024

/** 敏感键命中正则：api_key / apikey / secret / token / password / authorization / credential */
const REDACT_KEY = /api[_-]?key|secret|token|password|authorization|credential/i
const REDACT_DEPTH = 4
const REDACT_ARRAY_CAP = 50

export interface ResultViewData {
  kind: "text" | "structured" | "raw"
  body: string
  /** 序列化前的原始体积（字节），截断提示用 */
  originalBytes: number
  truncated: boolean
}

/** UTF-8 安全截断：按字节截断后回退到码点边界（与 server 侧 agent-result.ts 同语义） */
export function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  return slice.endsWith("�") ? slice.slice(0, -1) : slice
}

/** 脱敏：命中敏感键的对象字段值替换为 "[REDACTED]"（与 server 侧 agent-result.ts 同语义） */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= REDACT_DEPTH || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    return value.slice(0, REDACT_ARRAY_CAP).map((item) => redactValue(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1)
  }
  return out
}

/**
 * 结果正文格式化：text 原样 / structured JSON pretty-print（渲染前脱敏）/
 * 序列化失败退化 raw（String()）；超 20KB 截断。
 */
export function formatResultBody(
  value: unknown,
  outputType: "text" | "structured" | "unknown",
): ResultViewData {
  let kind: ResultViewData["kind"]
  let text: string
  if (outputType === "text" && typeof value === "string") {
    kind = "text"
    text = value
  } else {
    kind = outputType === "text" ? "raw" : "structured"
    try {
      const serialized = JSON.stringify(redactValue(value), null, 2)
      if (serialized === undefined) {
        kind = "raw"
        text = String(value)
      } else {
        text = serialized
      }
    } catch {
      kind = "raw"
      text = String(value)
    }
  }
  const originalBytes = Buffer.byteLength(text, "utf8")
  if (originalBytes <= RESULT_MAX_BYTES) {
    return { kind, body: text, originalBytes, truncated: false }
  }
  return {
    kind,
    body: truncateUtf8ByBytes(text, RESULT_MAX_BYTES),
    originalBytes,
    truncated: true,
  }
}

/** Node Detail 的结果展示状态（FR-4 空态三分 + 正文） */
export type ResultState =
  | { state: "error"; message: string }
  /** running 且无 result */
  | { state: "pending" }
  /** 终态但无 result（含 schema 路径合法的 null 与 journal 只记了执行历史的场景） */
  | { state: "empty" }
  | { state: "content"; view: ResultViewData; source: "journal" | "preview" }

/**
 * 空态三分判定（FR-4）：
 * 1. failed -> error（优先级最高，error 信息来自节点状态）
 * 2. running -> pending（"No result yet"）
 * 3. journal 有 result（非 null/undefined）-> content(journal)
 * 4. 无 journal result 但快照预览存在 -> content(preview)（journal 未写入/被清理的兜底）
 * 5. 否则 -> empty（"No result returned"）
 * aborted 无 journal 无 error 归 empty（中止语义在 header 呈现）。
 */
export function resolveResultState(input: {
  status: WorkflowNodeStatus
  error?: string
  entry: JournalEntryView | null
  preview?: string
}): ResultState {
  if (input.status === "failed") {
    return { state: "error", message: input.error ?? "Agent failed" }
  }
  if (input.status === "running") {
    return { state: "pending" }
  }
  const entry = input.entry
  if (entry && entry.result != null) {
    // outputType 缺省时按值的类型推断（老 journal 无 outputType 字段）
    const outputType =
      entry.outputType === "text" || entry.outputType === "structured"
        ? entry.outputType
        : typeof entry.result === "string"
          ? "text"
          : "structured"
    return { state: "content", view: formatResultBody(entry.result, outputType), source: "journal" }
  }
  if (typeof input.preview === "string" && input.preview.length > 0) {
    return { state: "content", view: { kind: "text", body: input.preview, originalBytes: Buffer.byteLength(input.preview, "utf8"), truncated: false }, source: "preview" }
  }
  return { state: "empty" }
}
