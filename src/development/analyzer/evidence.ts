/**
 * P3-D 证据评估
 *
 * evidenceIntegrity：原始工具输入/输出/来源是否完整
 * candidateConfidence：该证据是否足以支持某项优化建议
 *
 * 两个独立属性，不混用：
 *  - integrity 评估的是"数据是否完整"（客观事实）
 *  - confidence 评估的是"证据是否充分支持优化建议"（主观判断）
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import type {
  AnalysisToolEvent,
  ScriptExtractionCandidate,
  EvidenceIntegrity,
  CandidateConfidence,
} from "./types.js"

/**
 * 评估单个工具调用事件的证据完整性
 *
 * complete：input 非空且含核心字段（write 的 content、bash 的 command）
 * partial：input 存在但核心字段部分缺失，或 output 经截断且 outputPath 已过期
 *   - edit 工具的 input 通常只含 oldString/newString 片段
 *   - bash/read 工具 completed 但无 output（可能被截断）
 * missing：input 为空对象或核心字段完全缺失
 */
export function assessIntegrity(event: AnalysisToolEvent): EvidenceIntegrity {
  const input = event.input
  const inputKeys = Object.keys(input)

  // input 为空对象 → missing
  if (inputKeys.length === 0) return "missing"

  // 检查核心字段是否存在（按工具类型）
  const coreField = getCoreField(event.tool)
  if (!coreField) {
    // 未知工具类型，只要有 input 就算 complete
    return "complete"
  }

  const hasCore = input[coreField] !== undefined && input[coreField] !== null && input[coreField] !== ""

  if (!hasCore) return "missing"

  // edit 工具的 input 通常只含 oldString/newString 片段，不是完整文件
  if (event.tool === "edit") return "partial"

  // write 工具的核心数据在 input.content 中，output 只是确认信息
  // 所以 write 的完整性不依赖 output
  if (event.tool === "write") return "complete"

  // bash/read 工具 completed 但无 output → 可能被截断
  if (event.output === undefined && event.status === "completed") return "partial"

  return "complete"
}

/**
 * 评估脚本固化候选的置信度
 *
 * high：脚本完整 + 工具调用完成 + determinism=likely
 * medium：脚本完整 + 工具调用完成 + determinism=unknown
 * low：脚本截断 / 工具调用未完成 / determinism=unlikely
 */
export function assessConfidence(
  candidate: ScriptExtractionCandidate,
  integrity: EvidenceIntegrity,
): CandidateConfidence {
  // 脚本截断 → low
  if (integrity === "missing") return "low"

  // 工具调用未完成 → low
  if (!candidate.toolCallCompleted) return "low"

  // determinism=unlikely → low
  if (candidate.determinism === "unlikely") return "low"

  // determinism=unknown → medium
  if (candidate.determinism === "unknown") return "medium"

  // determinism=likely + 脚本完整 → high
  // determinism=likely + 脚本片段(partial) → medium
  if (integrity === "partial") return "medium"

  return "high"
}

/**
 * 评估全局证据完整性
 *
 * 全部 complete → complete
 * 有 missing → missing
 * 否则 → partial
 */
export function assessOverallIntegrity(events: AnalysisToolEvent[]): EvidenceIntegrity {
  if (events.length === 0) return "missing"

  let hasMissing = false
  let hasPartial = false

  for (const event of events) {
    const integrity = assessIntegrity(event)
    if (integrity === "missing") hasMissing = true
    if (integrity === "partial") hasPartial = true
  }

  if (hasMissing) return "missing"
  if (hasPartial) return "partial"
  return "complete"
}

/** 获取工具的核心字段名 */
function getCoreField(tool: string): string | undefined {
  switch (tool) {
    case "write":
      return "content"
    case "edit":
      return "newString"
    case "bash":
      return "command"
    case "read":
      return "filePath"
    default:
      return undefined
  }
}
