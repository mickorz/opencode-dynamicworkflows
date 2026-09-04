/**
 * workflow 结果渲染（F-07）
 * 前台 tool 返回与后台结果回传共用。
 */

import type { runWorkflow } from "../runtime/workflow-runtime.js";

/** tool 输出预算：平台默认 50KB 截断（tool/truncate.ts:13-14），自留 2KB 余量给头部与摘要 */
const OUTPUT_BUDGET_BYTES = 48 * 1024
/** agent 摘要最多展示的行数（超出部分折叠为一行计数说明） */
const AGENT_SUMMARY_MAX_LINES = 200

/** 渲染 tool 返回（F-07：return 值 + agent 单行摘要 + metadata，控制在截断预算内） */
export function renderWorkflowResult(
  result: Awaited<ReturnType<typeof runWorkflow>>,
): { title: string; output: string; metadata: Record<string, unknown> } {
  const failed = result.agents.filter((a) => a.status === "failed").length
  const abortedCount = result.agents.filter((a) => a.status === "aborted").length
  const replayed = result.agents.filter((a) => a.replayed).length
  const tokens = result.agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
  const cost = result.agents.reduce((sum, a) => sum + (a.cost ?? 0), 0)

  const lines: string[] = []
  lines.push(
    `工作流 ${result.meta.name} 完成：${result.agentCount} 个 agent` +
      `${failed ? `，${failed} 失败` : ""}${abortedCount ? `，${abortedCount} 中止` : ""}` +
      `${replayed ? `，${replayed} 缓存回放` : ""}` +
      `，耗时 ${(result.durationMs / 1000).toFixed(1)}s，共 ${tokens} tokens${cost > 0 ? `，成本 $${cost.toFixed(4)}` : ""}` +
      `（runId: ${result.runId}）`,
  )
  if (result.phases.length) lines.push(`阶段: ${result.phases.join(" > ")}`)

  lines.push("")
  lines.push("agent 摘要:")
  const shown = result.agents.slice(0, AGENT_SUMMARY_MAX_LINES)
  for (const agent of shown) {
    const status =
      agent.status === "ok"
        ? agent.replayed
          ? "缓存"
          : "成功"
        : agent.status === "failed"
          ? "失败"
          : agent.status === "aborted"
            ? "中止"
            : "运行中"
    const tokensPart = agent.tokens !== undefined ? ` ${agent.tokens} tok${agent.cost ? ` ($${agent.cost.toFixed(4)})` : ""}` : ""
    const errorPart = agent.error ? ` | ${agent.error}` : ""
    lines.push(`  [${status}] ${agent.label}${agent.phase ? ` (${agent.phase})` : ""}${tokensPart}${errorPart}`)
  }
  if (result.agents.length > AGENT_SUMMARY_MAX_LINES) {
    lines.push(`  ...其余 ${result.agents.length - AGENT_SUMMARY_MAX_LINES} 个 agent 见 metadata.agents`)
  }

  lines.push("")
  lines.push("## 结果")
  let resultJson = JSON.stringify(result.result, null, 2) ?? "null"
  // 结果过大时降级为紧凑 JSON，再超则截断（完整结构仍在 metadata.agents / 后续 journal）
  let output = lines.join("\n") + "\n```json\n" + resultJson + "\n```\n"
  if (Buffer.byteLength(output, "utf8") > OUTPUT_BUDGET_BYTES) {
    resultJson = JSON.stringify(result.result) ?? "null"
    output = lines.join("\n") + "\n```json\n" + resultJson + "\n```\n"
    if (Buffer.byteLength(output, "utf8") > OUTPUT_BUDGET_BYTES) {
      output =
        lines.join("\n") +
        `\n\`\`\`json\n${resultJson.slice(0, OUTPUT_BUDGET_BYTES - lines.join("\n").length - 64)}\n...(结果过大已截断)\n\`\`\`\n`
    }
  }
  if (result.logs.length) {
    output += `\n日志:\n${result.logs.slice(-20).join("\n")}`
  }
  // 续跑提示：有 live 写入过 journal 才提示（纯回放轮不提示）
  const journaled = result.agents.some((a) => !a.replayed && a.status === "ok")
  if (journaled) {
    output += `\n\n提示：迭代不重烧——修改脚本后重传 resumeFromRunId="${result.runId}"，未变 agent() 调用直接回放，仅改动的重跑。`
  }

  return {
    title: `workflow ${result.meta.name}`,
    output,
    metadata: {
      runId: result.runId,
      agentCount: result.agentCount,
      durationMs: result.durationMs,
      phases: result.phases,
      logs: result.logs,
      agents: result.agents,
      result: result.result,
      tokens,
      cost,
    },
  }
}
