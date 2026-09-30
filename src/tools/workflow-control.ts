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

export function createWorkflowControlTool(background: BackgroundRunManager) {
  return tool({
    description:
      "控制后台工作流：status 列出全部后台 run 与进度；stop 停止指定 runId 的运行中工作流（已完成的 agent 结果保留在 journal，可用 workflow 工具传 resumeFromRunId 续跑）。",
    args: {
      action: tool.schema.enum(["status", "stop"]).describe("status=查询全部；stop=停止指定 run。"),
      runId: tool.schema.string().optional().describe("stop 时必填：要停止的后台 run 的 runId。"),
    },
    async execute(input) {
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
