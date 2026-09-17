/**
 * schedule 工具面（P1 最小版：schedule_create + schedule_list）
 *
 * 薄壳：校验与编排全部在 ScheduleService；OS/文件细节不在工具层（AGENTS.md 边界）
 * Phase 2 补全 get/update/delete/enable/disable/run_now
 */

import { tool, type PluginInput } from "@opencode-ai/plugin"
import { createSchedule, listScheduleViews } from "../schedule/service.js"
import { nextRun } from "../schedule/cron.js"

export function createScheduleTools(_ctx: PluginInput) {
  const scheduleCreate = tool({
    description: "创建 Workflow 定时任务（Schedule）。自然语言的定时意图（每分钟/每小时/每天/每周）由调用方翻译成 cron 后传入。到点由插件内调度器确定性执行 workflowId（不经 LLM 判断）；OpenCode 运行期间生效，关闭后不执行、错过的时间点不补跑。",
    args: {
      workflowId: tool.schema.string().describe("workflowId（.opencode-workflows/workflows/ 下脚本的 meta.id ?? meta.name）"),
      cron: tool.schema.string().describe(
        'cron 子集四模式："*/n * * * *"（每 n 分钟）、"m * * * *"（每小时 m 分）、"m h * * *"（每天）、"m h * * W"（每周 W，0=周日）',
      ),
      name: tool.schema.string().optional().describe("展示名；缺省用 workflowId"),
      args: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("透传给 workflow 脚本的全局 args（JSON）"),
    },
    async execute(input, context) {
      try {
        const schedule = createSchedule({
          directory: context.directory,
          workflowId: input.workflowId,
          cron: input.cron,
          name: input.name,
          args: input.args,
        })
        const next = nextRun(schedule.cron, new Date()).toISOString()
        return {
          title: "schedule_create",
          output: [
            "Schedule 已创建",
            "",
            `ID: ${schedule.id}`,
            `Workflow: ${schedule.workflowId}`,
            `Cron: ${schedule.cron}`,
            `Next run: ${next}`,
            "Requires OpenCode running: Yes",
            "",
            "说明：OpenCode 运行期间到点自动执行；关闭 OpenCode 或休眠错过的轮次不补跑（下一个未来时间点正常执行）。查看用 schedule_list。",
          ].join("\n"),
        }
      } catch (error) {
        return {
          title: "schedule_create",
          output: `创建失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })

  const scheduleList = tool({
    description: "列出当前项目的全部 Workflow 定时任务：ID、Workflow、Cron、启用状态、下次执行时间、最近一次执行结果。",
    args: {},
    async execute(_input, context) {
      const views = listScheduleViews(context.directory)
      if (views.length === 0) {
        return {
          title: "schedule_list",
          output: "当前项目没有定时任务。用 schedule_create 创建（workflow 脚本放在 .opencode-workflows/workflows/ 下）。",
        }
      }
      const lines = views.map((v) => {
        const enabled = v.enabled ? "启用" : "停用"
        const next = v.enabled ? (v.nextRunAt ?? "-") : "-"
        const last = v.lastRunAt ? `${v.lastRunStatus} @ ${v.lastRunAt}` : "从未执行"
        const missing = v.workflowMissing ? " [警告: workflow 文件缺失]" : ""
        return `- ${v.id}${missing}\n  workflow: ${v.workflowId} | cron: ${v.cron} | ${enabled}\n  next: ${next} | last: ${last}`
      })
      return {
        title: "schedule_list",
        output: [`共 ${views.length} 个定时任务：`, ...lines].join("\n"),
      }
    },
  })

  return { schedule_create: scheduleCreate, schedule_list: scheduleList }
}
// _ctx 预留（Phase 2 run_now 需要 client 触发执行；Phase 1 仅 create/list 不直接用）
