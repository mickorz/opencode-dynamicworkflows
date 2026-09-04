/**
 * BackgroundRunManager —— 后台工作流注册表与生命周期（P2-2 / F-18 + F-17）
 *
 * 生命周期：
 *  start({client, parentSessionId, directory}, script, input)
 *   -> parseWorkflowScript 先验脚本（同步报错，不吞后台异常）
 *   -> 注册 runId -> { controller, 记录快照 } 到内存注册表
 *   -> 分离执行 runWorkflow（journal 逐 agent 落盘，onAgentUpdate 维护进度）
 *   -> 完成/失败/中止后，把渲染结果作为一条消息 prompt 回主会话（结果回传）
 *
 *  stop(runId)  -> controller.abort() -> runtime 停止派发 + 各子会话 abort 级联
 *  status()     -> 注册表快照（运行中/最近完成，完成的保留最近 20 条）
 *
 * 注意：
 *  - 后台 run 不接 tool context.abort（tool 调用早已返回），Esc 不影响后台——控制走 workflow_control
 *  - 中断/失败后 journal 已持久化，可用 workflow(resumeFromRunId) 续跑
 *  - checkpoint 在后台 run 无人工通道，走 headless default（与 Pi 后台语义一致）
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { runWorkflow } from "../runtime/workflow-runtime.js"
import { parseWorkflowScript } from "../runtime/vm.js"
import { OpenCodeSessionAdapter } from "../adapters/opencode-session-adapter.js"
import { JournalStore } from "../persistence/journal.js"
import { loadModelTiers } from "../agent/model-tiers.js"
import { renderWorkflowResult } from "./render.js"
import type { AgentRecord } from "../types/index.js"

export type BackgroundRunStatus = "running" | "completed" | "failed" | "aborted"

export interface BackgroundRunInfo {
  runId: string
  name: string
  status: BackgroundRunStatus
  startedAt: number
  endedAt?: number
  /** 各 agent 终态记录（onAgentUpdate 维护） */
  records: AgentRecord[]
  logs: string[]
  error?: string
  /** 是否已把结果回传主会话 */
  delivered?: boolean
}

/** 状态快照（给 workflow_control 展示用，不含内部对象） */
export type BackgroundRunSnapshot = BackgroundRunInfo

export interface BackgroundStartDeps {
  client: PluginInput["client"]
  parentSessionId: string
  directory: string
}

export interface BackgroundStartInput {
  script: string
  args?: Record<string, unknown>
  concurrency?: number
  maxAgents?: number
  agentTimeoutMs?: number
  agentRetries?: number
}

/** 完成后注册表里保留的历史条数 */
const KEEP_COMPLETED = 20

export class BackgroundRunManager {
  private readonly runs = new Map<string, InternalRun>()
  private seq = 0

  /** 启动后台 run；脚本非法立即抛错，否则立刻返回 runId */
  start(deps: BackgroundStartDeps, input: BackgroundStartInput): string {
    const { meta } = parseWorkflowScript(input.script)
    const runId = `run-${Date.now().toString(36)}-${++this.seq}`
    const info: BackgroundRunInfo = {
      runId,
      name: meta.name,
      status: "running",
      startedAt: Date.now(),
      records: [],
      logs: [],
    }
    const controller = new AbortController()
    this.runs.set(runId, { info, controller })
    this.prune()

    // 分离执行：不阻塞 tool 返回
    void this.execute(deps, input, info, controller)

    return runId
  }

  private async execute(
    deps: BackgroundStartDeps,
    input: BackgroundStartInput,
    info: BackgroundRunInfo,
    controller: AbortController,
  ): Promise<void> {
    const degradeNotes: string[] = []
    const adapter = new OpenCodeSessionAdapter({
      client: deps.client,
      parentSessionId: deps.parentSessionId,
      onStructuredDegrade: ({ label, reason }) => {
        const note = `agent "${label}" 结构化输出降级（网关不支持 json_schema，已改用 prompt JSON 模式）：${reason}`
        info.logs.push(note)
        degradeNotes.push(note)
      },
    })
    const journalStore = new JournalStore(deps.directory)
    const modelTiers = loadModelTiers({ projectDir: deps.directory })

    try {
      const result = await runWorkflow(input.script, {
        agent: adapter,
        args: input.args,
        concurrency: input.concurrency,
        maxAgents: input.maxAgents,
        agentTimeoutMs: input.agentTimeoutMs ?? null,
        agentRetries: input.agentRetries,
        signal: controller.signal,
        runId: info.runId,
        cwd: deps.directory,
        resolveTier: (tier) => modelTiers[tier],
        onAgentJournal: (entry) => {
          try {
            journalStore.append(entry.key.slice(0, entry.key.indexOf(":")), entry.key, {
              hash: entry.hash,
              result: entry.result,
              model: entry.model,
            })
          } catch {
            // 落盘失败不阻断运行
          }
        },
        onAgentUpdate: (record) => {
          const index = info.records.findIndex((r) => r.id === record.id)
          if (index >= 0) info.records[index] = record
          else info.records.push(record)
        },
      })
      info.status = "completed"
      info.logs.push(...result.logs, ...degradeNotes)

      // 结果回传：渲染文本作为一条消息发回主会话，Main Agent 接力汇报
      const rendered = renderWorkflowResult(result)
      info.delivered = true
      await deps.client.session.prompt({
        path: { id: deps.parentSessionId },
        body: {
          parts: [
            {
              type: "text",
              text: `[后台工作流已完成，以下是 tool 结果原文，请向用户汇报]\n\n${rendered.output}`,
            },
          ],
        },
      })
    } catch (error) {
      if (controller.signal.aborted) {
        info.status = "aborted"
        info.error = "被 workflow_control 停止"
      } else {
        info.status = "failed"
        info.error = error instanceof Error ? error.message : String(error)
      }
      info.logs.push(
        `后台工作流${info.status === "aborted" ? "被停止" : "失败"}：${info.error}。已完成的 agent 已记入 journal，可传 resumeFromRunId="${info.runId}" 续跑。`,
      )
      // 失败也回传主会话（用户需要知道）
      try {
        info.delivered = true
        await deps.client.session.prompt({
          path: { id: deps.parentSessionId },
          body: {
            parts: [{ type: "text", text: `[后台工作流状态：${info.status}]\n\n${info.logs[info.logs.length - 1]}` }],
          },
        })
      } catch {
        // 主会话可能已关闭；状态仍可在 workflow_control 里查到
      }
    } finally {
      info.endedAt = Date.now()
    }
  }

  /** 停止一个后台 run；返回是否找到且仍在运行 */
  stop(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.info.status !== "running") return false
    run.controller.abort()
    return true
  }

  /** 注册表快照 */
  status(): BackgroundRunSnapshot[] {
    return Array.from(this.runs.values()).map((run) => run.info)
  }

  private prune(): void {
    const completed = Array.from(this.runs.values())
      .filter((run) => run.info.status !== "running")
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0))
    for (const run of completed.slice(0, Math.max(0, completed.length - KEEP_COMPLETED))) {
      this.runs.delete(run.info.runId)
    }
  }
}

interface InternalRun {
  info: BackgroundRunInfo
  controller: AbortController
}
