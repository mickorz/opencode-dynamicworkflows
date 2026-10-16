/**
 * OptimizationJob 状态机（P4-0 定义，P4-A 接入持久化与触发）
 *
 * 类头流程图：
 *
 *  P3 Proposal 生成
 *        |
 *        v
 *  discovered -> aggregated（P4-A 聚合后 distinctRunCount 达标）
 *        -> planned（P4-B 生成 OptimizationPlan）
 *        -> generated（固化工具 + Workflow Patch 就绪）
 *        -> validating（P4-C worktree A/B）
 *        -> awaiting_approval（三道闸门全过）
 *        -> applied / rejected / failed（P4-D 结果）
 *
 * 约束（P4 执行文档 三 / 4.0.5）：
 *  - 同一 fingerprint 处于 aggregated 到 awaiting_approval 之间时不创建新 Job
 *  - 只有终态（applied/rejected/failed）后允许新一轮（optimizationAttempt + 1）
 *  - failed 候选需新 Run 产生新 occurrence 才能重试
 *  - 创建必须持久化、幂等、并发防重（多个 Run 并发完成只创建一次，P4-A 落地）
 *  - Patch 按目标 Workflow 分离：targetWorkflowPath + targetWorkflowHash
 *    是 Job 身份的一部分（P0-1）
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

/** 状态机：discovered 到 awaiting_approval 为活跃态，后三者为终态 */
export type OptimizationJobState =
  | "discovered"
  | "aggregated"
  | "planned"
  | "generated"
  | "validating"
  | "awaiting_approval"
  | "applied"
  | "rejected"
  | "failed"

/** OptimizationJob 持久化形状（development/optimization-jobs.json 的一条记录） */
export interface OptimizationJob {
  /** 候选内容 fingerprint 前 8 位 + 优化轮次（makeOptimizationId） */
  optimizationId: string
  /** 跨 Run 稳定指纹（P3 Proposal.candidateFingerprint） */
  candidateFingerprint: string
  /** Patch 目标 Workflow 脚本绝对路径（P0-1：按目标 Workflow 分离） */
  targetWorkflowPath: string
  /** 目标脚本基线哈希（manifest.workflowSource.scriptHash 同源；应用前校验未被修改） */
  targetWorkflowHash: string
  /** 候选主脚本哈希（P4-B 生成后填写） */
  candidateScriptHash?: string
  /** A/B 验证结果哈希（P4-C 完成后填写） */
  abResultHash?: string
  /** 该候选的第几轮优化（从 1 开始，上限 3） */
  optimizationAttempt: number
  /** 展示用标题（来自聚合候选，便于人读台账） */
  title?: string
  /** 进入终态时的独立 Run 数（下一轮重试门槛：需新 Run 产生新 occurrence，即 distinctRunCount 增长） */
  finishedDistinctRunCount?: number
  /** 累计真实 token 用量（跨阶段累计） */
  totalTokenUsed: number
  /** 该候选的 token 预算上限 */
  tokenBudget: number
  state: OptimizationJobState
  lastUpdatedTs: number
}

/**
 * optimizationId：fingerprint 前 8 位 + 目标 Workflow 哈希前 6 位 + 轮次。
 * P0-1：同 fingerprint 不同目标 Workflow 是不同 Job，ID 必须可区分；
 * 同 (fingerprint, 目标, 轮次) 的 id 稳定可复现。
 */
export function makeOptimizationId(fingerprint: string, targetWorkflowHash: string, optimizationAttempt: number): string {
  return `${fingerprint.slice(0, 8)}-${targetWorkflowHash.slice(0, 6)}-a${optimizationAttempt}`
}

/** 活跃态：discovered 到 awaiting_approval 之间（此区间同 fingerprint 不创建新 Job） */
export function isActiveOptimizationState(state: OptimizationJobState): boolean {
  return (
    state === "discovered" ||
    state === "aggregated" ||
    state === "planned" ||
    state === "generated" ||
    state === "validating" ||
    state === "awaiting_approval"
  )
}

/** 终态：applied / rejected / failed（终态后允许新一轮优化） */
export function isTerminalOptimizationState(state: OptimizationJobState): boolean {
  return state === "applied" || state === "rejected" || state === "failed"
}
