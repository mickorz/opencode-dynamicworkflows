/**
 * P4-C 独立隔离 A/B 验证（宿主无关）
 *
 * 类头流程图：
 *
 *  OptimizationJob（generated，候选与固化工具已产出）
 *        |
 *        v
 *  runABValidation
 *    1 双 worktree 创建（任一非 isolated -> 抛错，Job 转 failed，不降级）
 *    2 worktree B 部署候选文件包（候选 Workflow 覆盖原路径 + 固化工具）
 *    3 A 执行原版（cwd=worktreeA）/ B 执行候选（cwd=worktreeB）
 *      经注入的 AbScriptRunner（tools 层接 OpenCode Adapter，
 *      Agent Session directory 绑定 worktree cwd，非提示词约定）
 *    4 产物落各自 worktree artifacts/result.json
 *        |
 *        v
 *  evaluateAB 三道闸门（P4-0 契约二）
 *    功能等价：result.json 哈希一致
 *    安全隔离：原项目关键文件 before/after 哈希一致（检测手段）
 *    优化收益：token 或耗时改善且双方 completed
 *        |
 *        v
 *  ab-result.json 落盘 + abResultHash
 *    finally 拆除双 worktree（失败也拆）
 *
 * 约束（P4 执行文档 4.3）：
 *  - 本模块不 import Adapter/SDK（AGENTS.md：development 宿主无关），
 *    执行经 AbScriptRunner 注入；测试注入 fake runner
 *  - 验证执行不带 development（防递归由调用方保证）
 *  - worktree.isolated 只代表 git 工作树隔离（能力边界见文档 4.3.2）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, realpathSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { exec } from "node:child_process"
import { createWorktree, removeWorktree } from "../isolation/worktree.js"
import { evaluateAB, type AbEvaluation } from "./ab.js"
import { sha256Text } from "./workflow-source.js"
import type { OptimizationPlan } from "./candidate-generator.js"
import type { OptimizationJob } from "./optimization-job.js"

/** 单次脚本执行结果（tools 层真实实现 / 测试 fake） */
export interface AbRunOutcome {
  status: "completed" | "failed" | "aborted"
  /** workflow 脚本 return 的值（产物对比主体） */
  result: unknown
  durationMs: number
  /** 全部 agent token 用量合计 */
  totalTokens: number
  error?: string
}

/** 脚本执行器注入缝（真实实现为 OpenCode Adapter + runWorkflow） */
export interface AbScriptRunner {
  run(script: string, cwd: string): Promise<AbRunOutcome>
}

export interface RunAbInput {
  /** <项目>/.opencode-workflows */
  workflowsDir: string
  job: OptimizationJob
  plan: OptimizationPlan
  runner: AbScriptRunner
}

export interface AbResult {
  passed: boolean
  evaluation: AbEvaluation
  original: { status: string; durationMs: number; totalTokens: number }
  candidate: { status: string; durationMs: number; totalTokens: number }
  abResultHash: string
  abResultPath: string
}

/** A/B 执行的统一记录形状 */
interface SideOutcome {
  status: string
  durationMs: number
  totalTokens: number
}

/** 执行确定性命令并返回 stdout（失败/超时返回错误文本，两侧同败也可对比） */
function runDeterministic(command: string | undefined, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    if (!command) {
      resolve("<无确定性命令>")
      return
    }
    exec(command, { cwd, timeout: 30_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? `<命令失败: ${error.message}>` : String(stdout))
    })
  })
}

/**
 * 双 worktree 隔离 A/B 验证。
 * 抛错表示执行环境失败（worktree 不可用/读盘失败），调用方应把 Job 标 failed；
 * 返回 AbResult.passed=false 表示闸门未过（同样 failed 或保持验证不通过记录）。
 */
export async function runABValidation(input: RunAbInput): Promise<AbResult> {
  const { job, plan, runner } = input

  // 1. 双 worktree（强隔离：失败即抛，不降级）。base 只需在 repo 内，
  //    createWorktree 内部自行 rev-parse 定位 repo root。
  const worktreeBase = dirname(job.targetWorkflowPath)
  const worktreeA = await createWorktree(worktreeBase, `ab-orig-${job.optimizationId}`)
  const worktreeB = await createWorktree(worktreeBase, `ab-cand-${job.optimizationId}`)
  if (!worktreeA.isolated) {
    if (worktreeB.isolated) await removeWorktree(worktreeB)
    throw new Error(`worktree A 创建失败，拒绝在非隔离环境执行候选（${worktreeA.cwd}）`)
  }
  if (!worktreeB.isolated) {
    await removeWorktree(worktreeA)
    throw new Error(`worktree B 创建失败，拒绝在非隔离环境执行候选（${worktreeB.cwd}）`)
  }

  try {
    // 路径形态统一：realpathSync.native 消除 Windows 8.3 短名（ZHANGQ~1）与 junction，
    // 否则 path.relative 纯字符串比对会把长/短名视为不同盘符前缀，算出畸形相对路径。
    const repoRootReal = realpathSync.native(
      worktreeA.repoRoot ?? dirname(dirname(job.targetWorkflowPath)),
    )
    // 业务项目目录（OpenCode 启动目录）：worktree 是整个仓库的镜像，
    // 业务目录在 worktree 内对应 join(worktree, relative(repoRoot, businessDir))；
    // 用 worktree 根做 cwd 会导致脚本内 ./相对引用（子 workflow、配置）解析失败。
    const businessDirReal = dirname(realpathSync.native(input.workflowsDir))
    const businessRel = relative(repoRootReal, businessDirReal)
    const cwdA = join(worktreeA.cwd, businessRel)
    const cwdB = join(worktreeB.cwd, businessRel)

    // 2. 部署候选文件包到 worktree B（候选 Workflow 覆盖原路径 + 固化工具）
    const scriptRel = relative(businessDirReal, realpathSync.native(job.targetWorkflowPath))
    const toolRel = plan.solidifiedTool.deployRelPath
    const candidateScript = readFileSync(plan.candidateScriptPath, "utf8")
    const targetScriptInB = join(cwdB, scriptRel)
    mkdirSync(dirname(targetScriptInB), { recursive: true })
    writeFileSync(targetScriptInB, candidateScript, "utf8")
    const toolInB = join(cwdB, toolRel)
    mkdirSync(dirname(toolInB), { recursive: true })
    copyFileSync(plan.solidifiedTool.toolPath, toolInB)

    // 3. 隔离检测基线：原项目关键文件 before 哈希（统一 realpath 形态，前后一致）
    const watchFiles = [realpathSync.native(job.targetWorkflowPath), join(businessDirReal, toolRel)]
    const projectHashesBefore: Record<string, string> = {}
    for (const f of watchFiles) {
      projectHashesBefore[f] = existsSync(f) ? sha256Text(readFileSync(f, "utf8")) : "<absent>"
    }

    // 4. 分别执行（原版读原项目文件；候选用 worktree B 内部署副本，与 A 同源同 hash）
    const originalScript = readFileSync(job.targetWorkflowPath, "utf8")
    const outcomeA = await runner.run(originalScript, cwdA)
    const outcomeB = await runner.run(candidateScript, cwdB)

    // 5. 确定性产物：两侧各执行同一逻辑命令（A 临时脚本 / B 固化工具），stdout 对比
    //    ——功能等价闸门的确定性对比物（LLM 自由文本报告不做哈希比对）。
    const toolOutputA = await runDeterministic(plan.deterministicCheck?.originalCommand, cwdA)
    const toolOutputB = await runDeterministic(plan.deterministicCheck?.candidateCommand, cwdB)

    // 6. 产物快照：确定性输出 + 参考 result（result 含 LLM 自由文本，仅人工参考不进对比）
    const replacedKeys = new Set(
      plan.targetNodes.filter((t) => t.changeType === "replace-with-tool" && t.resultKey).map((t) => t.resultKey),
    )
    const project = (r: unknown): unknown =>
      r && typeof r === "object" && !Array.isArray(r)
        ? Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => !replacedKeys.has(k)))
        : r
    const artifactsA = join(cwdA, "artifacts")
    const artifactsB = join(cwdB, "artifacts")
    mkdirSync(artifactsA, { recursive: true })
    mkdirSync(artifactsB, { recursive: true })
    writeFileSync(join(artifactsA, "tool-output.txt"), toolOutputA, "utf8")
    writeFileSync(join(artifactsB, "tool-output.txt"), toolOutputB, "utf8")
    writeFileSync(join(artifactsA, "result.json"), JSON.stringify(project(outcomeA.result) ?? null, null, 2), "utf8")
    writeFileSync(join(artifactsB, "result.json"), JSON.stringify(project(outcomeB.result) ?? null, null, 2), "utf8")

    // 6. 隔离检测 after 哈希
    const projectHashesAfter: Record<string, string> = {}
    for (const f of watchFiles) {
      projectHashesAfter[f] = existsSync(f) ? sha256Text(readFileSync(f, "utf8")) : "<absent>"
    }

    // 7. 三道闸门（evaluateAB，P4-0 契约二；确定性输出做功能等价对比物）
    const bothCompleted = outcomeA.status === "completed" && outcomeB.status === "completed"
    const tokensImproved = outcomeB.totalTokens < outcomeA.totalTokens
    const faster = outcomeB.durationMs < outcomeA.durationMs
    const evaluation = await evaluateAB({
      artifactsToCompare: ["tool-output.txt"],
      originalArtifactsDir: artifactsA,
      candidateArtifactsDir: artifactsB,
      projectHashesBefore,
      projectHashesAfter,
      benefit: {
        improvement: bothCompleted && (tokensImproved || faster),
        detail: `token ${outcomeA.totalTokens}->${outcomeB.totalTokens}，耗时 ${outcomeA.durationMs}ms->${outcomeB.durationMs}ms，状态 ${outcomeA.status}/${outcomeB.status}`,
      },
    })

    // 8. ab-result.json 落盘 + 哈希
    const toSide = (o: AbRunOutcome): SideOutcome & { error?: string } => ({
      status: o.status,
      durationMs: o.durationMs,
      totalTokens: o.totalTokens,
      ...(o.error ? { error: o.error.slice(0, 500) } : {}),
    })
    const abResult = {
      schemaVersion: 1 as const,
      optimizationId: job.optimizationId,
      generatedAt: Date.now(),
      original: toSide(outcomeA),
      candidate: toSide(outcomeB),
      evaluation,
      passed: evaluation.functionalEquivalence && evaluation.isolationSafe && evaluation.benefitPositive,
    }
    const outDir = dirname(plan.candidateScriptPath)
    const abResultPath = join(outDir, "ab-result.json")
    writeFileSync(abResultPath, JSON.stringify(abResult, null, 2), "utf8")
    const abResultHash = sha256Text(JSON.stringify(abResult))

    return {
      passed: abResult.passed,
      evaluation,
      original: toSide(outcomeA),
      candidate: toSide(outcomeB),
      abResultHash,
      abResultPath,
    }
  } finally {
    // 无论成败拆除双 worktree
    await removeWorktree(worktreeA)
    await removeWorktree(worktreeB)
  }
}
