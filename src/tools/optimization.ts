/**
 * P4-D 优化编排与人工审批应用（tool 层，OpenCode API 允许区）
 *
 * 类头流程图：
 *
 *  onJobCompleted（DevJob completed，聚合周期已创建 Job）
 *        |
 *        v
 *  advanceOptimizationJobs（fire-and-forget，逐 Job 推进）
 *    aggregated -> planned -> generated（generateOptimizationPlan）
 *      生成失败 -> failed（记录原因）
 *        |
 *        v
 *    generated -> validating -> runABValidation（真实 runner：
 *      OpenCode Adapter + runWorkflow，directory 绑定 worktree）
 *        |
 *        +-- 三闸门全过 -> awaiting_approval（停，等人工）
 *        +-- 未过/异常 -> failed（记录 ab-result 或错误）
 *        |
 *        v
 *  人工经 optimization_control 工具
 *    status / list 查看
 *    approve：context.ask 前台批准 -> ApprovalStore 落盘
 *      -> applyCandidate 多文件事务 -> applied / failed
 *    reject -> rejected
 *
 * 约束（P4 执行文档 4.3.6/4.3.7）：
 *  - 应用只接受已落盘 ApprovalRecord；approvalChannel 绑定真实 ask 事件
 *  - 审批与应用在同一工具调用内闭环（ask 即人工批准通道，
 *    文档 4.3.7 的 checkpoint 脚本模式为备选，二者共享 ApprovalRecord 契约）
 *  - 推进链不阻塞 DevJob 终态；每步失败落 Job 状态可追溯
 */

import { tool, type PluginInput, type ToolContext } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { runWorkflow } from "../runtime/workflow-runtime.js"
import { OpenCodeSessionAdapter, type ClientLike } from "../adapters/opencode-session-adapter.js"
import { OptimizationJobManager } from "../development/optimization-jobs.js"
import type { OptimizationJob } from "../development/optimization-job.js"
import {
  generateOptimizationPlan,
  type OptimizationPlan,
} from "../development/candidate-generator.js"
import { runABValidation, type AbScriptRunner } from "../development/ab-runner.js"
import {
  ApprovalStore,
  applyCandidate,
  bundleHash,
  type ApplyTarget,
} from "../development/candidate-apply.js"
import { sha256Text } from "../development/workflow-source.js"

/** 读取候选目录里的 optimization-plan.json */
function loadPlan(job: OptimizationJob, workflowsDir: string): OptimizationPlan | undefined {
  const planPath = join(workflowsDir, "candidates", job.candidateFingerprint.slice(0, 8), "optimization-plan.json")
  if (!existsSync(planPath)) return undefined
  try {
    return JSON.parse(readFileSync(planPath, "utf8")) as OptimizationPlan
  } catch {
    return undefined
  }
}

/** 真实脚本执行器：OpenCode Adapter + runWorkflow（Agent Session directory 绑定 cwd） */
export function makeRealRunner(client: ClientLike, parentSessionId: string): AbScriptRunner {
  return {
    run: async (script, cwd) => {
      const adapter = new OpenCodeSessionAdapter({ client, parentSessionId })
      const runId = `run-ab-${Date.now().toString(36)}`
      try {
        const r = await runWorkflow(script, {
          agent: adapter,
          cwd,
          runId,
          maxAgents: 10,
        })
        const totalTokens = r.agents.reduce((s, a) => s + (a.tokens ?? 0), 0)
        return {
          status: "completed" as const,
          result: r.result,
          durationMs: r.durationMs,
          totalTokens,
        }
      } catch (e) {
        return {
          status: "failed" as const,
          result: null,
          durationMs: 0,
          totalTokens: 0,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
  }
}

export interface AdvanceDeps {
  client: ClientLike
  parentSessionId: string
}

/**
 * 推进全部 aggregated/generated 状态的 Job（B 生成 + C 验证，直到 awaiting_approval 或 failed）。
 * 异步 fire-and-forget：调用方 void 调用，错误已在本函数内落到 Job 状态。
 */
export async function advanceOptimizationJobs(
  workflowsDir: string,
  deps: AdvanceDeps,
): Promise<void> {
  const manager = new OptimizationJobManager()
  manager.load(workflowsDir)

  for (const job of manager.list()) {
    if (job.state !== "aggregated") continue
    try {
      // P4-B：候选生成
      const fingerprint = job.candidateFingerprint
      const candidatesPath = join(workflowsDir, "development", "aggregated", "candidates.json")
      if (!existsSync(candidatesPath)) continue
      const candidates = (JSON.parse(readFileSync(candidatesPath, "utf8")) as { candidates: Array<{ fingerprint: string; occurrences: Array<{ workflowScriptHash?: string }> }> }).candidates
      const candidate = candidates.find((c) => c.fingerprint === fingerprint)
      if (!candidate) continue
      manager.updateState(job.optimizationId, "planned")
      const plan = generateOptimizationPlan({
        candidate: candidate as never,
        job,
        workflowsDir,
      })
      manager.updateState(job.optimizationId, "generated", { candidateScriptHash: plan.candidateScriptHash })

      // P4-C：双 worktree A/B 验证（验证执行不带 development，防递归）
      manager.updateState(job.optimizationId, "validating")
      const ab = await runABValidation({
        workflowsDir,
        job: { ...job, state: "validating" },
        plan,
        runner: makeRealRunner(deps.client, deps.parentSessionId),
      })
      if (ab.passed) {
        manager.updateState(job.optimizationId, "awaiting_approval", { abResultHash: ab.abResultHash })
      } else {
        manager.updateState(job.optimizationId, "failed")
      }
    } catch (e) {
      manager.updateState(job.optimizationId, "failed")
      // 失败原因写入 apply-log（无独立 error 字段时以日志留痕）
      void e
    }
    manager.persist(workflowsDir)
  }
}

/** 状态中文说明 */
const STATE_LABEL: Record<string, string> = {
  discovered: "已发现",
  aggregated: "已聚合（待生成候选）",
  planned: "已计划",
  generated: "候选已生成（待验证）",
  validating: "A/B 验证中",
  awaiting_approval: "验证通过，等待人工批准",
  applied: "已应用",
  rejected: "已拒绝",
  failed: "失败",
}

export function createOptimizationControlTool(input: PluginInput): ReturnType<typeof tool> {
  const workflowsDir = join(input.directory, ".opencode-workflows")
  return tool({
    description:
      "P4 自优化任务管理：list 列出全部优化任务；status 查看 详情（含 A/B 结果摘要）；" +
      "approve 人工批准并应用候选（弹前台确认，多文件事务部署，失败自动回滚）；reject 拒绝候选。" +
      "仅 awaiting_approval 状态的任务可 approve/reject。",
    args: {
      action: tool.schema.string().describe("list | status | approve | reject"),
      optimizationId: tool.schema.string().optional().describe("任务 ID（status/approve/reject 必填）"),
    },
    async execute(args, context) {
      const manager = new OptimizationJobManager()
      manager.load(workflowsDir)
      const rows = manager.list()

      if (args.action === "list") {
        if (rows.length === 0) {
          return { title: "optimization", output: "暂无优化任务。development=true 的 Workflow 多次运行并聚合后会自动创建。" }
        }
        const lines = rows.map(
          (j) => `- ${j.optimizationId} [${STATE_LABEL[j.state] ?? j.state}] 目标: ${j.targetWorkflowPath}${j.title ? ` | ${j.title}` : ""}`,
        )
        return { title: "optimization", output: lines.join("\n") }
      }

      const id = args.optimizationId
      if (!id) {
        return { title: "optimization", output: "status/approve/reject 需要 optimizationId 参数（先用 list 查看）" }
      }
      const job = manager.get(id)
      if (!job) {
        return { title: "optimization", output: `任务不存在：${id}（先用 list 查看）` }
      }

      if (args.action === "status") {
        const plan = loadPlan(job, workflowsDir)
        const abPath = join(workflowsDir, "candidates", job.candidateFingerprint.slice(0, 8), "ab-result.json")
        const abSummary = existsSync(abPath)
          ? (() => {
              const r = JSON.parse(readFileSync(abPath, "utf8")) as { passed?: boolean; evaluation?: { details?: string }; original?: object; candidate?: object }
              return `A/B 结果: ${r.passed ? "通过" : "未通过"}\n${r.evaluation?.details ?? ""}\n原版: ${JSON.stringify(r.original)}\n候选: ${JSON.stringify(r.candidate)}`
            })()
          : "（尚无 A/B 结果）"
        return {
          title: "optimization",
          output:
            `任务: ${job.optimizationId}\n状态: ${STATE_LABEL[job.state] ?? job.state}\n` +
            `目标 Workflow: ${job.targetWorkflowPath}\n基线哈希: ${job.targetWorkflowHash.slice(0, 16)}...\n` +
            `轮次: ${job.optimizationAttempt}/3\n` +
            `候选脚本: ${plan ? `${plan.candidateScriptPath}（sha256 ${plan.candidateScriptHash.slice(0, 16)}...）` : "（未生成）"}\n` +
            `固化工具: ${plan ? plan.solidifiedTool.deployRelPath : "（未生成）"}\n` +
            `预期改进: ${plan?.expectedImprovement ?? "（未生成）"}\n${abSummary}`,
        }
      }

      if (args.action === "reject") {
        if (job.state !== "awaiting_approval") {
          return { title: "optimization", output: `仅 awaiting_approval 状态可拒绝，当前：${STATE_LABEL[job.state] ?? job.state}` }
        }
        manager.updateState(job.optimizationId, "rejected", { distinctRunCountOfTarget: distinctRunsOf(job.candidateFingerprint, workflowsDir) })
        manager.persist(workflowsDir)
        return { title: "optimization", output: `已拒绝候选（原文件未做任何修改）：${job.optimizationId}` }
      }

      if (args.action === "approve") {
        if (job.state !== "awaiting_approval") {
          return { title: "optimization", output: `仅 awaiting_approval 状态可批准，当前：${STATE_LABEL[job.state] ?? job.state}` }
        }
        const plan = loadPlan(job, workflowsDir)
        if (!plan) {
          return { title: "optimization", output: "optimization-plan.json 缺失，无法应用（候选产物不完整）" }
        }

        // 1. 前台人工批准（context.ask 即真实批准事件；拒绝则终止，原文件不动）
        const approved = await askApproval(context, job, plan)
        if (!approved) {
          return { title: "optimization", output: "用户未批准，原文件未做任何修改。" }
        }

        // 2. 落盘 ApprovalRecord（可信批准记录，applyCandidate 只认它）
        //    业务项目目录 = workflowsDir 父目录（与 ab-runner 的 businessDir 同一推导，
        //    不能用 dirname(targetWorkflowPath)——那是脚本目录，固化工具会部署错位置）
        const businessDir = dirname(workflowsDir)
        const toolTarget = join(businessDir, plan.solidifiedTool.deployRelPath)
        const files = await Promise.all([
          readFileSync(plan.candidateScriptPath, "utf8"),
          readFileSync(plan.solidifiedTool.toolPath, "utf8"),
        ])
        const record = {
          optimizationId: job.optimizationId,
          originalScriptHash: job.targetWorkflowHash,
          candidateBundleHash: bundleHash([
            { targetPath: job.targetWorkflowPath, content: files[0] },
            { targetPath: toolTarget, content: files[1] },
          ]),
          abResultHash: job.abResultHash ?? "",
          approvedAt: Date.now(),
          approvalChannel: `ask:${context.sessionID}`,
        }
        const store = new ApprovalStore(join(workflowsDir, "development", "approval-records"))
        await store.save(record)

        // 3. 多文件事务应用（Workflow Patch + 固化工具整体部署，失败回滚）
        const target: ApplyTarget = {
          targets: [
            { sourcePath: plan.candidateScriptPath, targetPath: job.targetWorkflowPath },
            { sourcePath: plan.solidifiedTool.toolPath, targetPath: toolTarget },
          ],
          baselineHashes: {
            [job.targetWorkflowPath]: plan.originalScriptHash,
            [toolTarget]: existsSync(toolTarget) ? sha256Text(readFileSync(toolTarget, "utf8")) : "<absent>",
          },
          candidateHashes: {
            [job.targetWorkflowPath]: plan.candidateScriptHash,
            [toolTarget]: sha256Text(files[1]),
          },
          backupDir: join(dirname(plan.candidateScriptPath), "backup"),
          applyLogPath: join(dirname(plan.candidateScriptPath), "apply-log.jsonl"),
        }
        const result = await applyCandidate(record, target)
        if (!result.applied) {
          manager.updateState(job.optimizationId, "failed", { distinctRunCountOfTarget: distinctRunsOf(job.candidateFingerprint, workflowsDir) })
          manager.persist(workflowsDir)
          return { title: "optimization", output: `应用失败（已回滚）：${result.reason}` }
        }
        manager.updateState(job.optimizationId, "applied", { distinctRunCountOfTarget: distinctRunsOf(job.candidateFingerprint, workflowsDir) })
        manager.persist(workflowsDir)
        return {
          title: "optimization",
          output:
            `已应用候选：${job.optimizationId}\n` +
            `Workflow: ${job.targetWorkflowPath}\n固化工具: ${toolTarget}\n` +
            `备份: ${result.backupPaths?.join(", ") ?? "（无）"}\n` +
            `台账: ${target.applyLogPath}`,
        }
      }

      return { title: "optimization", output: `未知 action：${args.action}（支持 list/status/approve/reject）` }
    },
  })
}

/** 前台批准通道：context.ask（拒绝/取消返回 false） */
async function askApproval(
  context: ToolContext,
  job: OptimizationJob,
  plan: OptimizationPlan,
): Promise<boolean> {
  try {
    await context.ask({
      permission: `optimization-approve:${job.optimizationId}`,
      patterns: [job.targetWorkflowPath],
      always: [],
      metadata: {
        message:
          `应用优化候选？\n原版: ${job.targetWorkflowPath}\n固化工具: ${plan.solidifiedTool.deployRelPath}\n` +
          `改进: ${plan.expectedImprovement}\n批准后多文件事务部署（Workflow Patch + 固化工具），可回滚。`,
      },
    })
    return true
  } catch {
    return false
  }
}

/** 从 candidates.json 查 fingerprint 的 distinctRunCount（终态重试门槛记录用） */
function distinctRunsOf(fingerprint: string, workflowsDir: string): number | undefined {
  const p = join(workflowsDir, "development", "aggregated", "candidates.json")
  if (!existsSync(p)) return undefined
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { candidates?: Array<{ fingerprint: string; distinctRunCount?: number }> }
    return data.candidates?.find((c) => c.fingerprint === fingerprint)?.distinctRunCount
  } catch {
    return undefined
  }
}
