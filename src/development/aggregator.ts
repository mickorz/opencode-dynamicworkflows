/**
 * 跨 Run 候选聚合器（P4-A，Exact Match）
 *
 * 类头流程图：
 *
 *  DevJob 完成（Optimizer 写出 proposals.json）
 *        |
 *        v
 *  runAggregationCycle（目录级触发入口）
 *        |
 *        v
 *  aggregateCandidates 扫描 history
 *    遍历 history/<runId>/attempts/<safeId>/analysis/proposals.json
 *    读 manifest.json 补 workflowSource 溯源（P4-0 契约一）
 *        |
 *        v
 *  按 candidateFingerprint 分组（Exact Match）
 *    occurrence 记录 runId/runAttemptId/ts
 *    Resume 同 runId 多 attempt：多条证据但不增 distinctRunCount
 *        |
 *        v
 *  按 Patch 目标 Workflow 再分组（P0-1：聚合共享，Patch 分离）
 *    组内 distinctRunCount >= 2 且 patchEligible
 *        |
 *        v
 *  OptimizationJobManager.createOnce（幂等防重）
 *        |
 *        v
 *  写 development/aggregated/candidates.json
 *
 * 约束（P4 执行文档 4.1）：
 *  - Exact Match：sha256(category + sourceTool + filePath + contentHash) 相同才聚合；
 *    不同路径或不同内容不合并（Similar Match 留 P4.1）
 *  - distinctRunCount >= 2 才自动创建 OptimizationJob
 *  - 内联脚本（workflowSource.kind=inline）无 Patch 资格，只保留候选建议
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { EvidenceRef, CandidateConfidence } from "./analyzer/types.js"
import type { WorkflowSource } from "../trace/types.js"
import { normalizedFingerprint, structuralFingerprint, similarityGroupId } from "./similarity.js"
import {
  OptimizationJobManager,
  type OptimizationJob,
} from "./optimization-jobs.js"

/** 单个 Proposal 出现记录 */
export interface CandidateOccurrence {
  runId: string
  runAttemptId: string
  proposalId: string
  ts: number
  confidence: CandidateConfidence
  integrity: string
  /** 该 occurrence 的脚本内容（每个都保留，不取最近一次） */
  sourceScript?: string
  suggestedTarget?: string
  /** Patch 目标 Workflow 溯源（来自 manifest.workflowSource，P4-0 契约一） */
  workflowScriptPath?: string
  workflowScriptHash?: string
  workflowSourceKind?: WorkflowSource["kind"]
  /** 原 L0 精确指纹（similar 组成员追溯用，P4.1-A） */
  originalFingerprint?: string
}

/** 跨 Run 聚合候选（同一 fingerprint 的多条证据合并） */
export interface AggregatedCandidate {
  /** 跨 Run 稳定指纹（P3 Proposal.candidateFingerprint） */
  fingerprint: string
  category: string
  title: string
  /** 各 occurrence 记录（保留全部，不取最近一次） */
  occurrences: CandidateOccurrence[]
  /** 总出现次数（含同 Run 多次） */
  occurrenceCount: number
  /** 跨独立业务 Run 数（Resume 不增加） */
  distinctRunCount: number
  /** 聚合证据引用（合并全部 occurrence 的 evidenceRefs，按稳定标识去重） */
  aggregatedEvidenceRefs: EvidenceRef[]
  /** 最高置信度（similar-candidate 上限 low；reviewed-compatible 上限 medium，需求 2.3） */
  bestConfidence: CandidateConfidence
  /** 全部 occurrence 都来自可 Patch 的 file 型 Workflow 才有自动 Patch 资格 */
  patchEligible: boolean
  /** P4.1-A：匹配模式（缺省 exact 向后兼容） */
  matchMode?: "exact" | "similar"
  /** similar 组 ID（锚点代表制派生，跨轮次稳定） */
  similarityGroupId?: string
  /** 三分类：similar-candidate（仅结构相似，待人工确认）/ reviewed-compatible（L3 复核+人工确认） */
  matchResult?: "similar-candidate" | "reviewed-compatible"
  /** 匹配级别 */
  matchLevel?: "L1" | "L2" | "L3"
}

const CONFIDENCE_RANK: Record<CandidateConfidence, number> = { high: 3, medium: 2, low: 1 }

/** 扫描到的一条 Proposal（带目录上下文） */
interface ScannedProposal {
  fingerprint: string
  runId: string
  runAttemptId: string
  ts: number
  proposal: Record<string, unknown>
  workflowSource?: WorkflowSource
}

/** 扫描 history 目录下全部 attempts 的 proposals.json 与 manifest.json */
function scanHistory(historyDir: string): ScannedProposal[] {
  const scanned: ScannedProposal[] = []
  if (!existsSync(historyDir)) return scanned

  for (const runId of readdirSync(historyDir)) {
    const runPath = join(historyDir, runId)
    const attemptsDir = join(runPath, "attempts")
    const attemptDirs = existsSync(attemptsDir)
      ? readdirSync(attemptsDir).map((a) => ({ attemptId: a, dir: join(attemptsDir, a) }))
      : [{ attemptId: runId, dir: runPath }] // 旧格式：无 attempts 子目录

    for (const { attemptId, dir } of attemptDirs) {
      const manifestPath = join(dir, "manifest.json")
      let workflowSource: WorkflowSource | undefined
      let manifestAttemptId: string | undefined
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          runAttemptId?: string
          workflowSource?: WorkflowSource
        }
        workflowSource = manifest.workflowSource
        manifestAttemptId = manifest.runAttemptId
      } catch {
        // 无 manifest 的 attempt：跳过溯源，proposal 仍可聚合（patchEligible 判定为否）
      }

      const proposalsPath = join(dir, "analysis", "proposals.json")
      if (!existsSync(proposalsPath)) continue
      try {
        const data = JSON.parse(readFileSync(proposalsPath, "utf8")) as {
          generatedAt?: number
          proposals?: Array<Record<string, unknown>>
        }
        for (const p of data.proposals ?? []) {
          const fingerprint = p.candidateFingerprint
          if (typeof fingerprint !== "string" || !fingerprint) continue
          scanned.push({
            fingerprint,
            runId,
            runAttemptId: manifestAttemptId ?? attemptId,
            ts: typeof data.generatedAt === "number" ? data.generatedAt : 0,
            proposal: p,
            workflowSource,
          })
        }
      } catch {
        // 损坏的 proposals.json 跳过，不阻断扫描
      }
    }
  }
  return scanned
}

/** evidenceRefs 去重键（稳定标识三元组） */
function evidenceKey(ref: EvidenceRef): string {
  return `${ref.runAttemptId}:${ref.sessionId}:${ref.callID}`
}

/**
 * 扫描 history 目录，聚合所有 Run 的 Proposal（Exact Match）
 *
 * @param historyDir history 根目录（<项目>/.opencode-workflows/history）
 * @param options.excludeFingerprints 已被活跃 OptimizationJob 占用的 fingerprint（防重复聚合）
 */
export function aggregateCandidates(
  historyDir: string,
  options: { excludeFingerprints?: string[]; reviews?: SimilarityReviewsFile } = {},
): AggregatedCandidate[] {
  const excluded = new Set(options.excludeFingerprints ?? [])
  const scanned = scanHistory(historyDir).filter((s) => !excluded.has(s.fingerprint))

  const groups = new Map<string, ScannedProposal[]>()
  for (const item of scanned) {
    const list = groups.get(item.fingerprint) ?? []
    list.push(item)
    groups.set(item.fingerprint, list)
  }

  const candidates: AggregatedCandidate[] = []
  for (const [fingerprint, items] of groups) {
    const occurrences: CandidateOccurrence[] = items.map((item) => ({
      runId: item.runId,
      runAttemptId: item.runAttemptId,
      proposalId: typeof item.proposal.id === "string" ? item.proposal.id : "",
      ts: item.ts,
      confidence: (typeof item.proposal.candidateConfidence === "string"
        ? item.proposal.candidateConfidence
        : "low") as CandidateConfidence,
      integrity: typeof item.proposal.evidenceIntegrity === "string" ? item.proposal.evidenceIntegrity : "missing",
      sourceScript: typeof item.proposal.sourceScript === "string" ? item.proposal.sourceScript : undefined,
      suggestedTarget: typeof item.proposal.suggestedTarget === "string" ? item.proposal.suggestedTarget : undefined,
      workflowScriptPath: item.workflowSource?.scriptPath,
      workflowScriptHash: item.workflowSource?.scriptHash,
      workflowSourceKind: item.workflowSource?.kind,
    }))

    // 合并证据引用（按稳定标识去重）
    const seen = new Set<string>()
    const mergedRefs: EvidenceRef[] = []
    for (const item of items) {
      const refs = Array.isArray(item.proposal.evidenceRefs) ? (item.proposal.evidenceRefs as EvidenceRef[]) : []
      for (const ref of refs) {
        const key = evidenceKey(ref)
        if (!seen.has(key)) {
          seen.add(key)
          mergedRefs.push(ref)
        }
      }
    }

    // 标题/类别取最新 occurrence 的 proposal（ts 最大）
    const latest = items.reduce((acc, cur) => (cur.ts >= acc.ts ? cur : acc), items[0])
    const best = occurrences.reduce<CandidateConfidence>(
      (acc, o) => (CONFIDENCE_RANK[o.confidence] > CONFIDENCE_RANK[acc] ? o.confidence : acc),
      "low",
    )

    candidates.push({
      fingerprint,
      category: typeof latest.proposal.category === "string" ? latest.proposal.category : "",
      title: typeof latest.proposal.title === "string" ? latest.proposal.title : "",
      occurrences,
      occurrenceCount: occurrences.length,
      distinctRunCount: new Set(occurrences.map((o) => o.runId)).size,
      aggregatedEvidenceRefs: mergedRefs,
      bestConfidence: best,
      patchEligible: occurrences.every(
        (o) => o.workflowSourceKind === "file" && !!o.workflowScriptPath && !!o.workflowScriptHash,
      ),
      matchMode: "exact",
    })
  }

  // P4.1-A：Similar Match（锦点代表制，需求 2.2/2.2.1）
  candidates.push(...buildSimilarCandidates(scanned, options.reviews))
  return candidates
}

// ============================================================
// P4.1-A：Similar Match 相似组（锦点代表制 + 三分类）
// ============================================================

/** L3 复核记录（人工确认时触发一次；持久化在 development/similarity-reviews.json） */
export interface SimilarityReviewRecord {
  compatible: boolean
  note: string
  reviewedAt: number
}

export interface SimilarityReviewsFile {
  schemaVersion: 1
  reviews: Record<string, SimilarityReviewRecord>
}

export function loadSimilarityReviews(workflowsDir: string): SimilarityReviewsFile {
  try {
    const raw = JSON.parse(readFileSync(join(workflowsDir, "development", "similarity-reviews.json"), "utf8")) as SimilarityReviewsFile
    return { schemaVersion: 1, reviews: raw.reviews ?? {} }
  } catch {
    return { schemaVersion: 1, reviews: {} }
  }
}

export function saveSimilarityReview(workflowsDir: string, groupId: string, record: SimilarityReviewRecord): void {
  const file = loadSimilarityReviews(workflowsDir)
  file.reviews[groupId] = record
  const dir = join(workflowsDir, "development")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "similarity-reviews.json"), JSON.stringify(file, null, 2), "utf8")
}

/** 相似组内部形状（锦点代表制） */
interface SimilarGroup {
  anchorF1: string
  f2: string
  level: "L1" | "L2"
  members: ScannedProposal[]
}

/**
 * Similar Match 分组（锦点代表制，需求 2.2.1）：
 *  - 按 ts 升序遍历，新脚本先比 L1 锦点再比 L2 锦点，命中入组；都未命中则自建组成为新锦点
 *  - 非传递：成员不注册比对索引（A约B、B约C 不代表 A约C 同组）
 *  - L2 成员加入后组级降 L2（保守）；组 ID 固定用建组锦点 L1 指纹（跨轮次稳定）
 *  - 仅产出增量组：成员 >=2 且组内 L0 指纹 >=2 种（全同 L0 已被 exact 覆盖）
 *  - 三分类（需求 2.2）：无复核记录 -> similar-candidate（不自动生成）；
 *    reviews[groupId].compatible -> reviewed-compatible（可进入生成，仍需 A/B 与审批）
 */
function buildSimilarCandidates(
  scanned: ScannedProposal[],
  reviews: SimilarityReviewsFile | undefined,
): AggregatedCandidate[] {
  // 仅 script-extraction 且带脚本内容的 occurrence 参与，按 ts 升序（锦点=最早成员）
  const pool = scanned
    .filter((s) => s.proposal.category === "script-extraction" && typeof s.proposal.sourceScript === "string")
    .sort((a, b) => a.ts - b.ts)

  const groups: SimilarGroup[] = []
  const byF1 = new Map<string, SimilarGroup>()
  const byF2 = new Map<string, SimilarGroup>()
  for (const item of pool) {
    const script = item.proposal.sourceScript as string
    const f1 = normalizedFingerprint(script)
    const existing1 = byF1.get(f1)
    if (existing1) {
      existing1.members.push(item)
      continue
    }
    const f2 = structuralFingerprint(script)
    const existing2 = byF2.get(f2)
    if (existing2) {
      existing2.members.push(item)
      existing2.level = "L2" // 组内最低匹配级别（保守）
      continue
    }
    const group: SimilarGroup = { anchorF1: f1, f2, level: "L1", members: [item] }
    groups.push(group)
    byF1.set(f1, group)
    byF2.set(f2, group)
  }

  const out: AggregatedCandidate[] = []
  for (const group of groups) {
    if (group.members.length < 2) continue
    const l0Fingerprints = new Set(group.members.map((m) => m.fingerprint))
    if (l0Fingerprints.size < 2) continue // exact 已覆盖，无增量

    const groupId = similarityGroupId(group.anchorF1)
    const review = reviews?.reviews[groupId]
    const reviewed = review?.compatible === true
    const matchResult = reviewed ? "reviewed-compatible" : "similar-candidate"

    const occurrences: CandidateOccurrence[] = group.members.map((item) => ({
      runId: item.runId,
      runAttemptId: item.runAttemptId,
      proposalId: typeof item.proposal.id === "string" ? item.proposal.id : "",
      ts: item.ts,
      confidence: (typeof item.proposal.candidateConfidence === "string"
        ? item.proposal.candidateConfidence
        : "low") as CandidateConfidence,
      integrity: typeof item.proposal.evidenceIntegrity === "string" ? item.proposal.evidenceIntegrity : "missing",
      sourceScript: item.proposal.sourceScript as string,
      suggestedTarget: typeof item.proposal.suggestedTarget === "string" ? item.proposal.suggestedTarget : undefined,
      workflowScriptPath: item.workflowSource?.scriptPath,
      workflowScriptHash: item.workflowSource?.scriptHash,
      workflowSourceKind: item.workflowSource?.kind,
      originalFingerprint: item.fingerprint,
    }))

    const mergedRefs: EvidenceRef[] = []
    const seen = new Set<string>()
    for (const item of group.members) {
      const refs = Array.isArray(item.proposal.evidenceRefs) ? (item.proposal.evidenceRefs as EvidenceRef[]) : []
      for (const ref of refs) {
        const key = evidenceKey(ref)
        if (!seen.has(key)) {
          seen.add(key)
          mergedRefs.push(ref)
        }
      }
    }

    const latest = group.members[group.members.length - 1]
    const rawBest = occurrences.reduce<CandidateConfidence>(
      (acc, o) => (CONFIDENCE_RANK[o.confidence] > CONFIDENCE_RANK[acc] ? o.confidence : acc),
      "low",
    )
    // 置信度上限（需求 2.3）：similar-candidate 上限 low；reviewed-compatible 上限 medium
    const cap: CandidateConfidence = reviewed ? "medium" : "low"
    const bestConfidence = CONFIDENCE_RANK[rawBest] > CONFIDENCE_RANK[cap] ? cap : rawBest

    out.push({
      fingerprint: groupId,
      category: "script-extraction",
      title: `${typeof latest.proposal.title === "string" ? latest.proposal.title : "相似脚本"}（相似组 ${groupId.slice(4, 12)}）`,
      occurrences,
      occurrenceCount: occurrences.length,
      distinctRunCount: new Set(occurrences.map((o) => o.runId)).size,
      aggregatedEvidenceRefs: mergedRefs,
      bestConfidence,
      patchEligible: occurrences.every(
        (o) => o.workflowSourceKind === "file" && !!o.workflowScriptPath && !!o.workflowScriptHash,
      ),
      matchMode: "similar",
      similarityGroupId: groupId,
      matchResult,
      matchLevel: reviewed ? "L3" : group.level,
    })
  }
  return out
}

// ============================================================
// 聚合产物持久化
// ============================================================

export interface AggregatedCandidatesFile {
  schemaVersion: 1
  generatedAt: number
  matchMode: "exact"
  candidates: AggregatedCandidate[]
}

/** 写 development/aggregated/candidates.json（聚合产物，人工与 P4-B 消费；全量视图，不因 Job 占用而丢展示） */
export function writeAggregatedCandidates(
  workflowsDir: string,
  candidates: AggregatedCandidate[],
): void {
  const dir = join(workflowsDir, "development", "aggregated")
  mkdirSync(dir, { recursive: true })
  const data: AggregatedCandidatesFile = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    matchMode: "exact",
    candidates,
  }
  writeFileSync(join(dir, "candidates.json"), JSON.stringify(data, null, 2), "utf8")
}

// ============================================================
// 触发入口：聚合 + 幂等创建 OptimizationJob
// ============================================================

export interface AggregationCycleResult {
  candidates: AggregatedCandidate[]
  createdJobs: OptimizationJob[]
}

/**
 * 聚合周期：扫描 -> 落盘聚合产物 -> 对达标候选创建 OptimizationJob（幂等）
 *
 * Job 粒度 = (fingerprint, 目标 Workflow)：
 *  - 候选内 occurrences 按 (workflowScriptPath + workflowScriptHash) 分组，
 *    每个目标 Workflow 单独判定组内 distinctRunCount >= 2（P0-1：禁止把
 *    A Workflow 的 Patch 应用到 B Workflow）
 *  - 非 patchEligible（含 inline 溯源）只保留聚合建议，不创建 Job
 *
 * @param workflowsDir <项目>/.opencode-workflows
 */
export function runAggregationCycle(workflowsDir: string): AggregationCycleResult {
  const historyDir = join(workflowsDir, "history")
  const manager = new OptimizationJobManager()
  manager.load(workflowsDir)

  // 全量聚合：candidates.json 是完整视图，不因活跃 Job 占用而丢展示；
  // Job 防重由 createOnce 幂等保证（活跃态返回既有，不新建）；
  // P4.1-A：相似组复核状态从 similarity-reviews 读取（三分类）
  const reviews = loadSimilarityReviews(workflowsDir)
  const candidates = aggregateCandidates(historyDir, { reviews })
  writeAggregatedCandidates(workflowsDir, candidates)

  const createdJobs: OptimizationJob[] = []
  for (const candidate of candidates) {
    if (!candidate.patchEligible) continue
    if (candidate.distinctRunCount < 2) continue
    // P4.1-A：similar-candidate 不自动生成（需求 2.4 误报防线：必须人工确认 + L3 复核）
    if (candidate.matchMode === "similar" && candidate.matchResult !== "reviewed-compatible") continue

    // 按目标 Workflow 分组（P0-1：聚合共享，Patch 分离）
    const byTarget = new Map<string, CandidateOccurrence[]>()
    for (const o of candidate.occurrences) {
      const key = `${o.workflowScriptPath}#${o.workflowScriptHash}`
      const list = byTarget.get(key) ?? []
      list.push(o)
      byTarget.set(key, list)
    }
    for (const occurrences of byTarget.values()) {
      const distinctRuns = new Set(occurrences.map((o) => o.runId)).size
      if (distinctRuns < 2) continue
      const first = occurrences[0]
      const job = manager.createOnce({
        candidateFingerprint: candidate.fingerprint,
        targetWorkflowPath: first.workflowScriptPath!,
        targetWorkflowHash: first.workflowScriptHash!,
        distinctRunCount: distinctRuns,
        title: candidate.title,
      })
      if (job) createdJobs.push(job)
    }
  }
  manager.persist(workflowsDir)
  return { candidates, createdJobs }
}
