/**
 * 测试助手（Node Inspector 改造后）：fake runner 的 AgentExecutionResult 包装。
 * AgentSessionRunner.run 的返回类型从裸 unknown 改为 AgentExecutionResult（FR-2），
 * 测试里的 fake runner 统一用这两个工厂包装返回值。
 */

import type { AgentExecutionResult } from "../src/agent/session-runner.js"

/** 文本路径结果包装 */
export function textResult(value: string, sessionId = "sess-fake"): AgentExecutionResult {
  return { type: "text", value, sessionId }
}

/** 结构化路径结果包装（value 可为任意 JSON 形状） */
export function structuredResult(value: unknown, sessionId = "sess-fake"): AgentExecutionResult {
  return { type: "structured", value, sessionId }
}
