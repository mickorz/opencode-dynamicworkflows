/**
 * TUI 侧 journal 只读端（Node Inspector 的结果内容通道，FR-6）
 *
 * server 布局契约：<项目目录>/.opencode-workflows/journal/<runId>.json
 * （写端见 src/persistence/journal.ts，跨进程同步，TUI 侧禁止 import server 模块）。
 * journal 永不清理（区别于 runs 快照），因此历史 run 与重启后的 result 仍可查看。
 *
 * 竞态容忍：server 侧已是原子写（tmp+rename），但读端仍必须宽松——
 * 任何解析失败一律返回 null，绝不抛错（与 run-snapshot-reader 同原则）。
 *
 * 纯 TypeScript 无 solid 依赖，node:test 直接可测。
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

/** 与 server 侧 SAFE_RUN_ID 同步（跨进程契约，兼防路径穿越） */
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]+$/

/** 与 server 侧 JournalEntry 对应的宽松视图（全部可选；老 journal 只有 hash/result/model） */
export interface JournalEntryView {
  hash?: string
  result?: unknown
  model?: string
  label?: string
  phase?: string
  agentType?: string
  prompt?: string
  sessionId?: string
  outputType?: "text" | "structured" | "unknown"
  executionId?: string
  attempt?: number
  startedAt?: number
  durationMs?: number
  usage?: { inputTokens?: number; outputTokens?: number }
  /** 历次尝试记录（最后一条即最新执行） */
  executions?: Array<{
    executionId: string
    attempt: number
    status: string
    label?: string
    sessionId?: string
    error?: string
    startedAt?: number
    durationMs?: number
  }>
}

/** 读原始文本（供调用方做 diff 守卫，避免每秒重解析大文件）；文件不存在/读失败返回 null */
export function readJournalRaw(directory: string, runId: string): string | null {
  if (!SAFE_RUN_ID.test(runId)) return null
  try {
    return readFileSync(join(directory, ".opencode-workflows", "journal", `${runId}.json`), "utf8")
  } catch {
    // 文件不存在或读失败（跨进程竞态等）
    return null
  }
}

/** 宽松解析：返回 key -> entry 的 Map；坏 JSON / 缺 entries 返回 null */
export function parseJournalFile(raw: string): Map<string, JournalEntryView> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const entries = (parsed as { entries?: unknown }).entries
  if (!entries || typeof entries !== "object") return null
  const out = new Map<string, JournalEntryView>()
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    out.set(key, sanitizeEntry(value as Record<string, unknown>))
  }
  return out
}

/** entry 字段清洗：逐字段 typeof 提取，坏形状字段丢弃不崩 */
function sanitizeEntry(rec: Record<string, unknown>): JournalEntryView {
  const usage = rec.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
  const executions: JournalEntryView["executions"] = Array.isArray(rec.executions)
    ? rec.executions
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object" && typeof (e as { executionId?: unknown }).executionId === "string")
        .map((e) => ({
          executionId: e.executionId as string,
          attempt: typeof e.attempt === "number" ? e.attempt : 0,
          status: typeof e.status === "string" ? e.status : "unknown",
          label: typeof e.label === "string" ? e.label : undefined,
          sessionId: typeof e.sessionId === "string" ? e.sessionId : undefined,
          error: typeof e.error === "string" ? e.error : undefined,
          startedAt: typeof e.startedAt === "number" ? e.startedAt : undefined,
          durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
        }))
    : undefined
  return {
    hash: typeof rec.hash === "string" ? rec.hash : undefined,
    result: "result" in rec ? rec.result : undefined,
    model: typeof rec.model === "string" ? rec.model : undefined,
    label: typeof rec.label === "string" ? rec.label : undefined,
    phase: typeof rec.phase === "string" ? rec.phase : undefined,
    agentType: typeof rec.agentType === "string" ? rec.agentType : undefined,
    prompt: typeof rec.prompt === "string" ? rec.prompt : undefined,
    sessionId: typeof rec.sessionId === "string" ? rec.sessionId : undefined,
    outputType:
      rec.outputType === "text" || rec.outputType === "structured" || rec.outputType === "unknown"
        ? rec.outputType
        : undefined,
    executionId: typeof rec.executionId === "string" ? rec.executionId : undefined,
    attempt: typeof rec.attempt === "number" ? rec.attempt : undefined,
    startedAt: typeof rec.startedAt === "number" ? rec.startedAt : undefined,
    durationMs: typeof rec.durationMs === "number" ? rec.durationMs : undefined,
    usage:
      usage && typeof usage === "object"
        ? {
            inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
            outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
          }
        : undefined,
    executions,
  }
}
