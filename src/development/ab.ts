/**
 * ABExecutor / ABEvaluator（P4-0 契约二：独立隔离 A/B 验证）
 *
 * 类头流程图：
 *
 *  P4-C 隔离 A/B 验证
 *        |
 *        +-- executeInWorktree（宿主 ABExecutor）
 *        |     非 isolated -> 抛错拒绝（不降级）
 *        |     isolated  -> run(cwd) 执行
 *        |     finally   -> removeWorktree 拆除
 *        |
 *        +-- evaluateAB（宿主 ABEvaluator）
 *              关键产物清单逐文件 sha256 -> functionalEquivalence
 *              原项目 before/after 哈希 -> isolationSafe（检测手段）
 *              benefit 证据 -> benefitPositive（缺省不放行）
 *        |
 *        v
 *  AbEvaluation 结构化结果（经 args 注入验证脚本，check() 消费）
 *
 * 约束（P4 执行文档 4.3.2 / 4.3.5）：
 *  - worktree.isolated === true 只代表 git 工作树隔离；本契约不宣称沙箱安全
 *  - 隔离检测是检测手段而非保证手段：检出修改即判失败且不进入审批
 *  - Workflow JS 内无 fs（VM 沙箱），产物对比必须在本模块（宿主）完成，
 *    check() 只消费本模块产出的结构化结果
 *  - benefitPositive 缺省为 false：无证据不放行
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { removeWorktree, type WorktreeInfo } from "../isolation/worktree.js"
import { sha256Text } from "./workflow-source.js"

/**
 * 在 worktree 内执行注入的宿主函数（ABExecutor 执行契约）
 *
 * 强隔离检查：非 isolated 直接抛错拒绝，不降级到共享目录。
 * 生命周期：run 成功/失败/中断都经 finally 拆除 worktree（cleanup=false 可保留，仅调试用）。
 *
 * run 的注入方（P4-C 的 OpenCode Adapter）负责把 Agent Session directory
 * 绑定到 worktree.cwd（Adapter 层传入，非提示词约定）。
 */
export async function executeInWorktree<T>(
  worktree: WorktreeInfo,
  run: (cwd: string) => Promise<T>,
  opts: { cleanup?: boolean } = {},
): Promise<T> {
  if (!worktree.isolated) {
    throw new Error(`worktree 创建失败，拒绝在非隔离环境执行候选（${worktree.cwd}）`)
  }
  try {
    return await run(worktree.cwd)
  } finally {
    if (opts.cleanup !== false) await removeWorktree(worktree)
  }
}

/** A/B 评估的结构化结果（验证脚本经 args 消费，check() 做闸门判定） */
export interface AbEvaluation {
  /** 功能等价：关键产物清单逐文件哈希一致 */
  functionalEquivalence: boolean
  /** 安全隔离：原项目文件 before/after 哈希一致（检测手段，检出修改即失败） */
  isolationSafe: boolean
  /** 优化收益：真实 Token/耗时/失败率至少一项改善（缺省无证据不放行） */
  benefitPositive: boolean
  /** 各闸门明细（人读 + 落 ab-result.json） */
  details: string
}

export interface EvaluateAbInput {
  /** 要对比的关键产物相对路径清单（来自验证计划；不提供全目录扫描） */
  artifactsToCompare: string[]
  /** 原版产物快照根目录 */
  originalArtifactsDir: string
  /** 候选产物快照根目录 */
  candidateArtifactsDir: string
  /** 原项目文件哈希（候选执行前），key 为相对/绝对路径 */
  projectHashesBefore: Record<string, string>
  /** 原项目文件哈希（候选执行后） */
  projectHashesAfter: Record<string, string>
  /** 优化收益证据（Run 指标对比结果，P4-C 提供；缺省不放行） */
  benefit?: { improvement: boolean; detail?: string }
}

/** 单文件对比明细 */
interface FileDiff {
  path: string
  status: "match" | "mismatch" | "missing-original" | "missing-candidate"
}

/** 对比单文件在两个快照目录中的内容哈希 */
async function diffArtifact(
  relPath: string,
  originalDir: string,
  candidateDir: string,
): Promise<FileDiff> {
  const originalPath = join(originalDir, relPath)
  const candidatePath = join(candidateDir, relPath)
  if (!existsSync(originalPath)) return { path: relPath, status: "missing-original" }
  if (!existsSync(candidatePath)) return { path: relPath, status: "missing-candidate" }
  const [a, b] = await Promise.all([
    readFile(originalPath, "utf8"),
    readFile(candidatePath, "utf8"),
  ])
  return sha256Text(a) === sha256Text(b)
    ? { path: relPath, status: "match" }
    : { path: relPath, status: "mismatch" }
}

/**
 * 宿主侧 A/B 评估（ABEvaluator）：产物对比、隔离检测、收益证据汇总
 */
export async function evaluateAB(input: EvaluateAbInput): Promise<AbEvaluation> {
  // 功能等价：关键产物清单逐文件比对
  const diffs: FileDiff[] = []
  for (const relPath of input.artifactsToCompare) {
    diffs.push(await diffArtifact(relPath, input.originalArtifactsDir, input.candidateArtifactsDir))
  }
  const functionalEquivalence = diffs.every((d) => d.status === "match")

  // 安全隔离：原项目 before/after 全量比对（检测手段，检出修改即失败）
  const modified = Object.keys(input.projectHashesBefore).filter(
    (p) => input.projectHashesBefore[p] !== input.projectHashesAfter[p],
  )
  const isolationSafe = modified.length === 0

  // 优化收益：无证据不放行
  const benefitPositive = input.benefit?.improvement === true

  const detailsParts: string[] = []
  detailsParts.push(
    functionalEquivalence
      ? `功能等价：${diffs.length} 个关键产物哈希一致`
      : `功能等价失败：${diffs.filter((d) => d.status !== "match").map((d) => `${d.path}(${d.status})`).join(", ")}`,
  )
  detailsParts.push(
    isolationSafe
      ? "安全隔离：原项目文件未被修改"
      : `安全隔离失败：原项目被修改 ${modified.join(", ")}`,
  )
  detailsParts.push(
    input.benefit
      ? `优化收益：${input.benefit.improvement ? "有改善" : "无改善"}${input.benefit.detail ? `（${input.benefit.detail}）` : ""}`
      : "优化收益：无证据（未提供 Run 指标对比），不放行",
  )

  return {
    functionalEquivalence,
    isolationSafe,
    benefitPositive,
    details: detailsParts.join("；"),
  }
}
