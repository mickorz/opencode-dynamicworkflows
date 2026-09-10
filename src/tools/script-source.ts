/**
 * 脚本来源解析（需求文档：工作流脚本陈旧缓存风险与解决方案 方案 A）
 *
 * script（原文）与 scriptPath（文件路径）二选一：
 *  - scriptPath 由服务端执行时读盘，必然是磁盘当前版本，
 *    绕开 Main Agent 上下文里上一轮 Read 的陈旧内容
 *  - 校验错误完整暴露（带路径），不做静默降级
 */
import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

export interface ScriptSourceInput {
  script?: unknown
  scriptPath?: unknown
}

/** 解析脚本文本：二选一校验 + scriptPath 服务端读盘 */
export function resolveScriptText(input: ScriptSourceInput, cwd: string): string {
  const hasScript = typeof input.script === "string" && input.script.trim().length > 0
  const hasPath = typeof input.scriptPath === "string" && input.scriptPath.trim().length > 0
  if (hasScript && hasPath) {
    throw new Error("script 与 scriptPath 二选一：两个都传了，请只保留其一（执行文件用 scriptPath）")
  }
  if (!hasScript && !hasPath) {
    throw new Error("workflow 需要 script（脚本原文）或 scriptPath（脚本文件路径）参数")
  }
  if (hasScript) return input.script as string

  const scriptPath = (input.scriptPath as string).trim()
  const absolute = isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath)
  try {
    return readFileSync(absolute, "utf8")
  } catch (error) {
    throw new Error(
      `scriptPath 读取失败（${absolute}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
