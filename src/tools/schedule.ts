/**
 * schedule 工具面（P1：8 个工具全量）
 *
 * 薄壳：校验与编排在 ScheduleService；执行在 ScheduleRuntime；文件/OS 细节不进工具层（AGENTS.md 边界）
 * /schedule command（安装器分发的模板）是用户体验层，复用这批工具
 */

import { tool, type PluginInput } from "@opencode-ai/plugin"
import {
  createSchedule,
  listScheduleViews,
  getScheduleView,
  updateSchedule,
  setScheduleEnabled,
  removeSchedule,
} from "../schedule/service.js"
import { nextRun } from "../schedule/cron.js"
import type { ScheduleRuntime } from "../schedule/runtime.js"

function err(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createScheduleTools(_ctx: PluginInput, scheduler: ScheduleRuntime) {
  const scheduleCreate = tool({
    description: "创建 Workflow 定时任务（Schedule）。自然语言的定时意图（每分钟/每小时/每天/每周）由调用方翻译成 cron 后传入。到点由插件内调度器确定性执行 workflowId（不经 LLM 判断）；OpenCode 运行期间生效，关闭后不执行、错过的时间点不补跑。",
    args: {
      workflowId: tool.schema.string().describe("workflowId（.opencode-workflows/workflows/ 下脚本的 meta.id ?? meta.name）"),
      cron: tool.schema.string().describe(
        "cron 子集四模式：每 n 分钟（星/n 空格 星 星 星 星）、每小时 m 分、每天 h 点 m 分、每周 W 的 h 点 m 分（W 0-6，0=周日）",
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
        return { title: "schedule_create", output: `创建失败：${err(error)}` }
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

  const scheduleGet = tool({
    description: "查询单个定时任务的完整信息：配置、下次执行、最近执行历史（最近 5 条）。",
    args: { id: tool.schema.string().describe("schedule ID") },
    async execute(input, context) {
      try {
        const v = getScheduleView(context.directory, input.id)
        const history = v.history.length
          ? v.history.map((r) => `  - ${r.startedAt} ${r.status}${r.error ? `（${r.error}）` : ""}`).join("\n")
          : "  （从未执行）"
        return {
          title: "schedule_get",
          output: [
            `ID: ${v.id}`,
            `Workflow: ${v.workflowId}${v.workflowMissing ? " [警告: workflow 文件缺失]" : ""}`,
            `Cron: ${v.cron} | ${v.enabled ? "启用" : "停用"}`,
            `Next run: ${v.enabled ? (v.nextRunAt ?? "-") : "（停用）"}`,
            `Last run: ${v.lastRunAt ? `${v.lastRunStatus} @ ${v.lastRunAt}` : "从未执行"}`,
            `Timeout: ${v.timeoutMs ? `${v.timeoutMs}ms` : "无"}`,
            `Requires OpenCode running: Yes`,
            "",
            "最近执行历史：",
            history,
          ].join("\n"),
        }
      } catch (error) {
        return { title: "schedule_get", output: err(error) }
      }
    },
  })

  const scheduleUpdate = tool({
    description: "更新定时任务的可变字段（name/cron/args/timeoutMs/enabled）；workflowId 不可改（需要时删除后重建）。",
    args: {
      id: tool.schema.string().describe("schedule ID"),
      name: tool.schema.string().optional().describe("新展示名"),
      cron: tool.schema.string().optional().describe("新 cron（四模式子集）"),
      args: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("新 args（整体替换）"),
      timeoutMs: tool.schema.number().optional().describe("单轮超时毫秒数"),
      enabled: tool.schema.boolean().optional().describe("启用状态"),
    },
    async execute(input, context) {
      try {
        const updated = updateSchedule(context.directory, input.id, input)
        return {
          title: "schedule_update",
          output: [
            "Schedule 已更新",
            `ID: ${updated.id}`,
            `Cron: ${updated.cron} | ${updated.enabled ? "启用" : "停用"}`,
            `Next run: ${updated.enabled ? nextRun(updated.cron, new Date()).toISOString() : "（停用）"}`,
          ].join("\n"),
        }
      } catch (error) {
        return { title: "schedule_update", output: `更新失败：${err(error)}` }
      }
    },
  })

  const scheduleDelete = tool({
    description: "删除定时任务（仅删 schedule 配置，不删 workflow 脚本文件；历史执行记录保留）。",
    args: { id: tool.schema.string().describe("schedule ID") },
    async execute(input, context) {
      try {
        removeSchedule(context.directory, input.id)
        return { title: "schedule_delete", output: `已删除定时任务 ${input.id}（workflow 文件未动）` }
      } catch (error) {
        return { title: "schedule_delete", output: `删除失败：${err(error)}` }
      }
    },
  })

  const scheduleEnable = tool({
    description: "启用定时任务（恢复到点自动执行）。",
    args: { id: tool.schema.string().describe("schedule ID") },
    async execute(input, context) {
      try {
        const s = setScheduleEnabled(context.directory, input.id, true)
        return { title: "schedule_enable", output: `已启用 ${s.id}，下次执行 ${nextRun(s.cron, new Date()).toISOString()}` }
      } catch (error) {
        return { title: "schedule_enable", output: err(error) }
      }
    },
  })

  const scheduleDisable = tool({
    description: "停用定时任务（保留配置，停止自动执行；用 schedule_enable 恢复）。",
    args: { id: tool.schema.string().describe("schedule ID") },
    async execute(input, context) {
      try {
        const s = setScheduleEnabled(context.directory, input.id, false)
        return { title: "schedule_disable", output: `已停用 ${s.id}（配置保留，用 schedule_enable 恢复）` }
      } catch (error) {
        return { title: "schedule_disable", output: err(error) }
      }
    },
  })

  const scheduleRunNow = tool({
    description: "立即执行一次定时任务（调试/验证用）：跳过时间判定直接走定时执行路径（fresh session 后台执行，结果落执行记录），返回 runId 不阻塞。",
    args: { id: tool.schema.string().describe("schedule ID") },
    async execute(input, context) {
      const result = await scheduler.runNow(input.id)
      if (result.error) {
        return { title: "schedule_run_now", output: result.error }
      }
      return {
        title: "schedule_run_now",
        output: [
          `已启动立即执行（runId: ${result.runId}）。`,
          "后台运行不阻塞本轮对话；每轮一个独立会话（可在会话列表按时间找到），结果摘要用 schedule_get 查看，停止用 workflow_control。",
        ].join("\n"),
        metadata: { runId: result.runId },
      }
    },
  })

  return {
    schedule_create: scheduleCreate,
    schedule_list: scheduleList,
    schedule_get: scheduleGet,
    schedule_update: scheduleUpdate,
    schedule_delete: scheduleDelete,
    schedule_enable: scheduleEnable,
    schedule_disable: scheduleDisable,
    schedule_run_now: scheduleRunNow,
  }
}
