/**
 * workflow_control 工具（P2-3 / F-17）—— 控制后台工作流
 *
 * 动作：
 *  status          -> 列出后台 run（运行中在前，含进度 X/N 与状态）
 *  stop(runId)     -> 停止一个运行中的后台 run（abort 级联子会话；journal 保留可续跑）
 *
 * 设计说明：pause/resume 不单独做——停止 + workflow(resumeFromRunId) 的 journal
 * 回放语义天然覆盖（与 Pi 的 pause=abort、resume=journal replay 同思路）。
 */

import { tool } from "@opencode-ai/plugin"
import type { BackgroundRunManager, BackgroundRunSnapshot } from "./background-runs.js"
import { JournalStore } from "../persistence/journal.js"
import { CHECKPOINT_PENDING_MARKER } from "../runtime/workflow-runtime.js"

export function createWorkflowControlTool(background: BackgroundRunManager) {
  return tool({
    description:
      "控制后台工作流：status 列出全部后台 run 与进度；stop 停止指定 runId 的运行中工作流（已完成的 agent 结果保留在 journal，可用 workflow 工具传 resumeFromRunId 续跑）。",
    args: {
      action: tool.schema.enum(["status", "stop", "checkpoint_reply"]).describe("status=查询全部；stop=停止指定 run；checkpoint_reply=回答挂起的 question 型 checkpoint（写入 journal 并返回续跑指引）。"),
      runId: tool.schema.string().optional().describe("stop / checkpoint_reply 时必填：目标 runId。"),
      answers: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional().describe("checkpoint_reply 时填：用户作答（选项 label 数组或自定义文本；multiple 时可为多元素）。"),
      rejected: tool.schema.boolean().optional().describe("checkpoint_reply 时填：用户取消/拒绝则 true（续跑时 checkpoint 强停止）。"),
    },
    async execute(input, context) {
      // checkpoint_reply（#35）：把用户经 question 工具的作答覆写进挂起标记的 journal entry，
      // 并给出续跑指引（工具层不自动续跑——复用 workflow(resumeFromRunId) 的既有回放链路）
      if (input.action === "checkpoint_reply") {
        if (!input.runId) {
          return { title: "workflow_control", output: "checkpoint_reply 需要 runId 参数" }
        }
        const store = new JournalStore(context.directory)
        const entries = store.load(input.runId)
        const pending = [...entries.entries()].filter(([, e]) => e.result === CHECKPOINT_PENDING_MARKER)
        if (pending.length === 0) {
          return {
            title: "workflow_control",
            output: `run "${input.runId}" 没有挂起中的 checkpoint（可能已作答，或 run 不存在）。`,
          }
        }
        // 取最新一条挂起（正常流程一次只有一条；多次挂起时按序应答）
        const [key, entry] = pending.at(-1)!
        if (input.rejected === true) {
          entry.result = false
        } else {
          const answers = Array.isArray(input.answers) ? input.answers : [String(input.answers ?? "")]
          entry.result = answers
        }
        store.append(input.runId, key, entry)
        const scriptPath = entry.scriptPath && entry.scriptPath !== "(inline script)" ? entry.scriptPath : undefined
        const argsHint = entry.args ? `，args 传 ${JSON.stringify(entry.args)}` : ""
        const resumeCmd = scriptPath
          ? `用 workflow 工具执行 scriptPath 传 ${scriptPath}，resumeFromRunId 传 ${input.runId}${argsHint}`
          : `用 workflow 工具执行原脚本，resumeFromRunId 传 ${input.runId}${argsHint}`
        return {
          title: "workflow_control",
          output: [
            `作答已写入 journal（${input.rejected === true ? "用户拒绝，续跑时该 checkpoint 将强停止" : `answers: ${JSON.stringify(entry.result)}`}）。`,
            `请续跑：${resumeCmd}。`,
            `已完成部分将回放不重烧 token；若主会话已无原脚本，从本条 output 里找不到 scriptPath 时请向用户确认原脚本来源。`,
          ].join("\n"),
        }
      }

      if (input.action === "stop") {
        if (!input.runId) {
          return { title: "workflow_control", output: "stop 需要 runId 参数" }
        }
        const stopped = background.stop(input.runId)
        return {
          title: "workflow_control",
          output: stopped
            ? `已停止后台 run "${input.runId}"（在飞子会话一并取消）。已完成部分在 journal 中，可用 workflow(resumeFromRunId="${input.runId}") 续跑。`
            : `未找到运行中的 run "${input.runId}"（可能已完成、已停止或不存在）；用 action=status 查看全部。`,
        }
      }

      // status
      const runs = background.status()
      if (runs.length === 0) {
        return { title: "workflow_control", output: "当前没有后台工作流记录。" }
      }
      const lines: string[] = ["后台工作流："]
      const order = { running: 0, completed: 1, failed: 2, aborted: 3 } as const
      for (const run of [...runs].sort((a, b) => order[a.status] - order[b.status] || b.startedAt - a.startedAt)) {
        lines.push(`  [${statusText(run)}] ${run.name}  runId: ${run.runId}  ${progressText(run)}`)
        if (run.error) lines.push(`    ${run.error}`)
      }
      return {
        title: "workflow_control",
        output: lines.join("\n"),
        metadata: { runs },
      }
    },
  })
}

function statusText(run: BackgroundRunSnapshot): string {
  return { running: "运行中", completed: "已完成", failed: "失败", aborted: "已停止" }[run.status]
}

function progressText(run: BackgroundRunSnapshot): string {
  const done = run.records.filter((r) => r.status !== "running").length
  const failed = run.records.filter((r) => r.status === "failed").length
  const seconds = ((run.endedAt ?? Date.now()) - run.startedAt) / 1000
  return `${done}/${run.records.length} agent${failed ? `（${failed} 失败）` : ""}，${seconds.toFixed(0)}s`
}
