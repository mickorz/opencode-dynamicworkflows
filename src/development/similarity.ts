/**
 * Similarity 指纹（P4.1-A：L1 规范化 + L2 结构指纹，纯函数）
 *
 * 类头流程图：
 *
 *  occurrence sourceScript
 *        |
 *        v
 *  L1 规范化 normalizeScript
 *    剥注释 块注释与行注释
 *    压空白 空行 行尾 连续空格
 *    引号统一 单引号转双引号
 *        |
 *        +--> sha256 --> L1 规范化指纹（同脚本微改写聚合）
 *        |
 *        v
 *  L2 结构指纹 structuralFingerprint
 *    在 L1 规范化文本上词法 token 化
 *    标识符替换为 ID 占位
 *    字符串内容与数字保留（常量不折叠 误报优先于漏检）
 *        |
 *        +--> sha256 --> L2 结构指纹（重命名与参数化变体聚合）
 *
 * 约束（P4.1 需求 2.2）：
 *  - 纯文本启发式（无解析器依赖）：字符串内注释符可能被误剥、
 *    三引号与单引号 docstring 归一有误差——两类误差对匹配双方对称，
 *    且误报由 常量保留 + 人工确认 + A/B 三层兜底
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { createHash } from "node:crypto"

/** 文本 sha256（utf8） */
function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * L1 规范化：剥注释 + 压空白 + 引号统一。
 * 仅同脚本微改写（注释/空行/缩进尾随/引号风格）归一为相同文本。
 */
export function normalizeScript(source: string): string {
  // 1. 剥块注释（/* ... */，跨行；非贪婪）
  let text = source.replace(/\/\*[\s\S]*?\*\//g, "")
  // 2. 逐行处理：剥行注释（# 与 //）+ 压空白 + 引号统一
  const lines: string[] = []
  for (const rawLine of text.split("\n")) {
    let line = rawLine
    // 行注释：// 与 #（启发式：接受字符串内误剥的对称误差）
    const lineCommentIndex = findLineComment(line)
    if (lineCommentIndex >= 0) line = line.slice(0, lineCommentIndex)
    // 引号统一：'x' -> "x"（成对替换内容两侧引号）
    line = line.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
    // 压空白：行内连续空白 -> 单空格；去首尾空白
    line = line.replace(/\s+/g, " ").trim()
    if (line.length === 0) continue // 去空行
    lines.push(line)
  }
  return lines.join("\n")
}

/** 行注释起点：'//' 或 '#'（不在行首字符串内的启发式：取先出现者；URL 中的 // 会被误剥，对称误差） */
function findLineComment(line: string): number {
  const slash = line.indexOf("//")
  const hash = line.indexOf("#")
  if (slash < 0 && hash < 0) return -1
  if (slash < 0) return hash
  if (hash < 0) return slash
  return Math.min(slash, hash)
}

/** L1 规范化指纹 */
export function normalizedFingerprint(source: string): string {
  return sha(normalizeScript(source))
}

/**
 * L2 词法 token 化（在 L1 规范化文本上）：
 *  - 标识符（字母/下划线开头）替换为 ID 占位
 *  - 字符串字面量保留内容（常量不折叠：字段名/阈值/键名参与身份）
 *  - 数字原样保留（阈值参与身份）
 *  - 其余符号原样
 */
export function tokenize(source: string): string[] {
  const text = normalizeScript(source)
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      // 字符串字面量：保留内容（含转义），输出 "内容" 形式
      let j = i + 1
      let value = ""
      while (j < text.length) {
        if (text[j] === "\\") {
          value += text.slice(j, j + 2)
          j += 2
          continue
        }
        if (text[j] === '"') break
        value += text[j]
        j += 1
      }
      tokens.push(`"${value}"`)
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      // 标识符或关键字：标识符统一占位，关键字（语言常用集）保留以维持控制流形状
      let j = i
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1
      const word = text.slice(i, j)
      tokens.push(KEYWORDS.has(word) ? word : "ID")
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      // 数字原样（阈值/计数参与身份）
      let j = i
      while (j < text.length && /[0-9.]/.test(text[j])) j += 1
      tokens.push(text.slice(i, j))
      i = j
      continue
    }
    if (ch === " ") {
      i += 1
      continue // 空白不产 token
    }
    tokens.push(ch)
    i += 1
  }
  return tokens
}

/** Python + JavaScript 常用关键字（保留以区分控制流形状；两语言并集，误留无碍——占位化差异对称） */
const KEYWORDS = new Set([
  "def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from", "as",
  "class", "try", "except", "finally", "raise", "with", "lambda", "pass", "break", "continue", "global", "None", "True", "False",
  "function", "const", "let", "var", "await", "async", "new", "typeof", "instanceof", "of", "null", "undefined", "true", "false", "throw", "catch", "export",
])

/** L2 结构指纹 */
export function structuralFingerprint(source: string): string {
  return sha(tokenize(source).join(" "))
}

/** 相似组 ID：锚点代表制（组内最早成员的 L1 规范化指纹派生，跨轮次稳定；
 *  不含级别前缀——组级可能因后续 L2 成员加入而降级，级别单独记在 matchLevel） */
export function similarityGroupId(anchorNormalizedFingerprint: string): string {
  return `sim-${anchorNormalizedFingerprint.slice(0, 16)}`
}
