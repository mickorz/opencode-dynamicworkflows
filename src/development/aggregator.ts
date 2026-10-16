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
  /** 最高置信度 */
  bestConfidence: CandidateConfidence
  /** 全部 occurrence 都来自可 Patch 的 file 型 Workflow 才有自动 Patch 资格 */
  patchEligible: boolean
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
  options: { excludeFingerprints?: string[] } = {},
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
    })
  }
  return candidates
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
  // Job 防重由 createOnce 幂等保证（活跃态返回既有，不新建）
  const candidates = aggregateCandidates(historyDir)
  writeAggregatedCandidates(workflowsDir, candidates)

  const createdJobs: OptimizationJob[] = []
  for (const candidate of candidates) {
    if (!candidate.patchEligible) continue
    if (candidate.distinctRunCount < 2) continue

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
