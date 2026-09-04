import { tool, type PluginInput } from "@opencode-ai/plugin"
import { runWorkflow } from "../runtime/workflow-runtime.js"
import { OpenCodeSessionAdapter } from "../adapters/opencode-session-adapter.js"
import { JournalStore } from "../persistence/journal.js"
import { loadModelTiers } from "../agent/model-tiers.js"
import { renderWorkflowResult } from "./render.js"
import { BackgroundRunManager } from "./background-runs.js"
import type { JournalEntry } from "../types/index.js"

const DESCRIPTION = [
  "运行动态工作流：执行一段 JavaScript 编排脚本，通过 agent() 将任务分发给子代理（独立会话）并行执行，",
  "parallel()/pipeline() 组合调度，脚本内变量汇总后仅返回最终结果，避免大量子代理上下文污染主会话。",
  "适用形态：全仓检查、独立并行调研、多视角评审、扇出汇总。编写脚本前先加载 workflow-authoring skill。",
  "脚本规则：首条语句 export const meta = { name, description }；可用全局 agent/parallel/pipeline/phase/log/args/verify/judgePanel/retry/checkpoint；",
  "禁止 import/require/Date.now()/Math.random()/new Date()；agent() 至少调用一次。",
  "agent() 缺省用只读的 explore 子代理，写文件类任务显式传 { agentType: 'general' }。",
].join("")

export function createWorkflowTool(ctx: PluginInput, background: BackgroundRunManager) {
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
      resumeFromRunId: tool.schema.string().optional().describe(
        "续跑某次历史 run（传入上次结果里的 runId）与修改后的 script：未变的 agent() 调用直接从 journal 回放（不调 LLM），首个变更调用及其后全部重跑。调用按位置匹配，保持前序调用不变且有序。",
      ),
      background: tool.schema.boolean().optional().describe(
        "后台运行（P2）：true 时立即返回 runId不阻塞本轮对话，完成后结果自动发回本会话；用 workflow_control 工具查状态或停止。缺省 false（前台阻塞直到完成）。后台 run 的 checkpoint 走 headless 默认值。",
      ),
    },

    async execute(input, context) {
      const script = normalizeWorkflowScript(input.script)
      if (!script) {
        return { title: "workflow", output: "workflow 需要 script 字符串参数" }
      }

      // 后台路径（P2-2）：立即返回 runId，结果完成后回传主会话
      if (input.background) {
        let runId: string
        try {
          runId = background.start(
            { client: ctx.client, parentSessionId: context.sessionID, directory: context.directory },
            {
              script,
              args: input.args,
              concurrency: input.concurrency,
              maxAgents: input.maxAgents,
              agentTimeoutMs: input.agentTimeoutMs,
              agentRetries: input.agentRetries,
            },
          )
        } catch (error) {
          return {
            title: "workflow",
            output: `后台工作流启动失败（脚本校验）：${error instanceof Error ? error.message : String(error)}`,
          }
        }
        return {
          title: "workflow",
          output: `后台工作流已启动（runId: ${runId}）。本轮对话不被阻塞；完成后结果会自动发回本会话。可用 workflow_control 查询进度或停止；中断后可用 resumeFromRunId="${runId}" 续跑。`,
          metadata: { runId, background: true },
        }
      }

      // journal：按项目目录落盘，逐 agent 写入（中断后续跑仍可回放已完成部分）
      const journalStore = new JournalStore(context.directory)
      let resumeJournal: Map<string, JournalEntry> | undefined
      if (input.resumeFromRunId) {
        resumeJournal = journalStore.load(input.resumeFromRunId)
        if (resumeJournal.size === 0) {
          return {
            title: "workflow",
            output: `找不到 run "${input.resumeFromRunId}" 的 journal（该项目目录下无 .opencode-workflows/journal/<runId>.json，或内容为空）；直接省略 resumeFromRunId 开新 run。`,
          }
        }
      }
      let journaledRunId: string | undefined
      const modelTiers = loadModelTiers({ projectDir: context.directory })
      const resolveTier = (tier: string) => modelTiers[tier]
      // checkpoint 人工确认通道：ToolContext.ask 的允许/拒绝映射为 true/false（拒绝不抛错，脚本可分支处理）
      const confirm = async (promptText: string): Promise<unknown> => {
        try {
          await context.ask({
            permission: "workflow-checkpoint",
            patterns: [promptText.slice(0, 120)],
            always: [],
            metadata: { message: promptText },
          })
          return true
        } catch {
          return false
        }
      }
      const onAgentJournal = (entry: JournalEntry & { key: string }) => {
        journaledRunId = entry.key.slice(0, entry.key.indexOf(":"))
        try {
          journalStore.append(journaledRunId, entry.key, {
            hash: entry.hash,
            result: entry.result,
            model: entry.model,
          })
        } catch {
          // 落盘失败不阻断运行（journal 仅影响回放优化）
        }
      }

      const degradeNotes: string[] = []
      const adapter = new OpenCodeSessionAdapter({
        client: ctx.client,
        parentSessionId: context.sessionID,
        onStructuredDegrade: ({ label, reason }) => {
          degradeNotes.push(`agent "${label}" 结构化输出降级（网关不支持 json_schema，已改用 prompt JSON 模式）：${reason}`)
        },
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
          resolveTier,
          confirm,
          cwd: context.directory,
          runId: input.resumeFromRunId,
          resumeJournal,
          onAgentJournal,
        })
        // 结构化降级可观测性：附在日志尾部（P1-2）
        for (const note of degradeNotes) result.logs.push(note)
        return renderWorkflowResult(result)
      } catch (error) {
        if (runController.signal.aborted || (error instanceof Error && /abort/i.test(error.message))) {
          // 用户中断：返回已完成的进度摘要而非抛错（平台会把 tool part 标记为 interrupted）
          const resumeHint = journaledRunId
            ? `\n已完成的 agent 已记入 journal，续跑请传 resumeFromRunId="${journaledRunId}"。`
            : ""
          return {
            title: "workflow",
            output: `工作流被用户中断：${error instanceof Error ? error.message : String(error)}${resumeHint}`,
          }
        }
        throw error
      } finally {
        context.abort.removeEventListener("abort", onAbort)
      }
    },
  })
}



/** 剥离可能的 markdown 围栏（照搬 Pi normalizeWorkflowScript） */
function normalizeWorkflowScript(script: string): string {
  let text = script.trim()
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i)
  if (fence) text = fence[1].trim()
  return text
}
