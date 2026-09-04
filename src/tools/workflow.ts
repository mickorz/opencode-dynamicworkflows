/**
 * workflow 自定义 tool（F-01/F-07）—— Main Agent 的唯一入口
 *
 * 执行流程：
 *  execute(args, context)
 *   -> 剥离 markdown 围栏 + runWorkflow(script, options)
 *        -> Runtime（vm 沙箱 + agent/parallel/pipeline/phase/log/args）
 *             -> OpenCodeSessionAdapter -> client.session.*
 *   -> abort 级联：context.abort -> run 级 controller -> 各 agent 的 attempt controller
 *   -> 渲染输出：结果 JSON + agent 单行摘要（控制在 50KB 截断预算内，F-07/N-07）
 *   -> metadata：{ runId, agents, phases, logs, agentCount, durationMs, tokens }
 */

import { tool, type PluginInput } from "@opencode-ai/plugin"
import { runWorkflow } from "../runtime/workflow-runtime.js"
import { OpenCodeSessionAdapter } from "../adapters/opencode-session-adapter.js"

/** tool 输出预算：平台默认 50KB 截断（tool/truncate.ts:13-14），自留 2KB 余量给头部与摘要 */
const OUTPUT_BUDGET_BYTES = 48 * 1024
/** agent 摘要最多展示的行数（超出部分折叠为一行计数说明） */
const AGENT_SUMMARY_MAX_LINES = 200

const DESCRIPTION = [
  "运行动态工作流：执行一段 JavaScript 编排脚本，通过 agent() 将任务分发给子代理（独立会话）并行执行，",
  "parallel()/pipeline() 组合调度，脚本内变量汇总后仅返回最终结果，避免大量子代理上下文污染主会话。",
  "适用形态：全仓检查、独立并行调研、多视角评审、扇出汇总。编写脚本前先加载 workflow-authoring skill。",
  "脚本规则：首条语句 export const meta = { name, description }；只可用 agent/parallel/pipeline/phase/log/args；",
  "禁止 import/require/Date.now()/Math.random()/new Date()；agent() 至少调用一次。",
  "agent() 缺省用只读的 explore 子代理，写文件类任务显式传 { agentType: 'general' }。",
].join("")

export function createWorkflowTool(ctx: PluginInput) {
  return tool({
    description: DESCRIPTION,

    args: {
      script: tool.schema.string().describe(
        "JavaScript 工作流脚本原文，无 markdown 围栏。首条语句必须是 export const meta = { name: 'short_snake_case', description: '...' }。可用全局：agent(prompt, opts) / parallel(函数数组) / pipeline(items, ...stages) / phase(title) / log(msg) / args。详见 workflow-authoring skill。",
      ),
      args: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe(
        "暴露给脚本的全局 args 对象（JSON）。",
      ),
      concurrency: tool.schema.number().optional().describe("最大并发 agent 数，钳制上限 16；缺省 CPU核数-2。"),
      maxAgents: tool.schema.number().optional().describe("本次 run 的 agent 总数上限，缺省 1000。"),
      agentTimeoutMs: tool.schema.number().optional().describe("单 agent 超时毫秒数；缺省不设硬超时。"),
      agentRetries: tool.schema.number().optional().describe("可恢复失败的自动重试次数（上限 3），缺省 0。"),
    },

    async execute(input, context) {
      const script = normalizeWorkflowScript(input.script)
      if (!script) {
        return { title: "workflow", output: "workflow 需要 script 字符串参数" }
      }

      const adapter = new OpenCodeSessionAdapter({
        client: ctx.client,
        parentSessionId: context.sessionID,
      })

      // abort 级联：Esc 中断主会话 -> context.abort -> run 级信号 -> 各 agent attempt 取消 + 子会话 abort
      const runController = new AbortController()
      const onAbort = () => runController.abort()
      if (context.abort.aborted) runController.abort()
      else context.abort.addEventListener("abort", onAbort)

      try {
        const result = await runWorkflow(script, {
          agent: adapter,
          args: input.args,
          concurrency: input.concurrency,
          maxAgents: input.maxAgents,
          agentTimeoutMs: input.agentTimeoutMs ?? null,
          agentRetries: input.agentRetries,
          signal: runController.signal,
        })
        return renderResult(result, false)
      } catch (error) {
        if (runController.signal.aborted || (error instanceof Error && /abort/i.test(error.message))) {
          // 用户中断：返回已完成的进度摘要而非抛错（平台会把 tool part 标记为 interrupted）
          return {
            title: "workflow",
            output: `工作流被用户中断：${error instanceof Error ? error.message : String(error)}`,
          }
        }
        throw error
      } finally {
        context.abort.removeEventListener("abort", onAbort)
      }
    },
  })
}

/** 渲染 tool 返回（F-07：return 值 + agent 单行摘要 + metadata，控制在截断预算内） */
function renderResult(
  result: Awaited<ReturnType<typeof runWorkflow>>,
  _aborted: boolean,
): { title: string; output: string; metadata: Record<string, unknown> } {
  const failed = result.agents.filter((a) => a.status === "failed").length
  const abortedCount = result.agents.filter((a) => a.status === "aborted").length
  const tokens = result.agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)

  const lines: string[] = []
  lines.push(
    `工作流 ${result.meta.name} 完成：${result.agentCount} 个 agent` +
      `${failed ? `，${failed} 失败` : ""}${abortedCount ? `，${abortedCount} 中止` : ""}` +
      `，耗时 ${(result.durationMs / 1000).toFixed(1)}s，共 ${tokens} tokens` +
      `（runId: ${result.runId}）`,
  )
  if (result.phases.length) lines.push(`阶段: ${result.phases.join(" > ")}`)

  lines.push("")
  lines.push("agent 摘要:")
  const shown = result.agents.slice(0, AGENT_SUMMARY_MAX_LINES)
  for (const agent of shown) {
    const status = agent.status === "ok" ? "成功" : agent.status === "failed" ? "失败" : agent.status === "aborted" ? "中止" : "运行中"
    const tokensPart = agent.tokens !== undefined ? ` ${agent.tokens} tok` : ""
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
    },
  }
}

/** 剥离可能的 markdown 围栏（照搬 Pi normalizeWorkflowScript） */
function normalizeWorkflowScript(script: string): string {
  let text = script.trim()
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) text = fence[1].trim()
  return text
}
