/**
 * 结果展示助手（FR-5，Node Inspector）——纯函数、零依赖、宿主无关。
 *
 * 职责：为快照 outputPreview 与 journal prompt 字段提供截断 / 脱敏 / 序列化。
 * 注意：TUI 侧 src/tui/result-view.ts 持有同语义的独立副本（跨进程禁止 import server），
 * 两处实现需人工同步。
 *
 * 不变量：本文件只处理展示副本，绝不修改 journal 的 result 原值——
 * resume 回放要把原值喂给脚本，脱敏只发生在展示面。
 */

/** 快照里结果预览的字节预算（预览仅作 journal 不可用时的兜底展示） */
export const OUTPUT_PREVIEW_LIMIT_BYTES = 2048
/** journal 里 prompt 的字节预算（仅展示用，不参与 hash 身份） */
export const PROMPT_JOURNAL_LIMIT_BYTES = 4096

/** 敏感键命中正则：api_key / apikey / secret / token / password / authorization / credential */
const REDACT_KEY = /api[_-]?key|secret|token|password|authorization|credential/i
/** 脱敏递归深度上限（防超深嵌套） */
const REDACT_DEPTH = 4
/** 脱敏数组元素上限（防超长数组拖慢预览构建） */
const REDACT_ARRAY_CAP = 50

/**
 * UTF-8 安全截断：按字节截断后回退到码点边界，避免截出半个多字节字符。
 * subarray 切在多字节中间时末尾会解析为 U+FFFD，去掉一个字符即可回到边界。
 */
export function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")
  return slice.endsWith("�") ? slice.slice(0, -1) : slice
}

/**
 * 预留脱敏（FR-5）：命中敏感键的对象字段值替换为 "[REDACTED]"。
 * 只处理展示副本；深度超限原样返回，数组截断到 cap。
 */
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
 * 快照预览构建：脱敏 -> 序列化（string 原样 / 对象 JSON pretty）-> 2KB 截断。
 * 序列化失败（循环引用等）退化为 String() 截断。
 */
export function buildOutputPreview(value: unknown, maxBytes = OUTPUT_PREVIEW_LIMIT_BYTES): string {
  let text: string
  try {
    if (typeof value === "string") {
      text = value
    } else {
      const serialized = JSON.stringify(redactValue(value), null, 2)
      text = serialized === undefined ? String(value) : serialized
    }
  } catch {
    text = String(value)
  }
  return truncateUtf8ByBytes(text, maxBytes)
}

/** journal 载荷用的 prompt 截断 */
export function truncatePromptForJournal(prompt: string): string {
  return truncateUtf8ByBytes(prompt, PROMPT_JOURNAL_LIMIT_BYTES)
}
