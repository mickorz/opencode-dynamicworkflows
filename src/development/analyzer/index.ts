/**
 * P3-E Analyzer 入口
 *
 * analyzeRun：确定性分析主函数
 *
 * 调用链：
 *  DevJobManager.startOptimizer
 *    -> analyzeRun(store, runId, manifest, agents, generatedAt)
 *      -> buildAnalysisEvents（适配层）
 *      -> 五类规则检测
 *      -> buildProposals（只有 script-extraction 自动生成）
 *      -> buildReport（纯函数生成 report.md + proposals.json）
 *      -> store.writeAnalysis
 *    -> 根据 analysisStatus 决定分支 A/B1/B2
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import type { TraceStore } from "../../trace/store.js"
import type { TraceManifest } from "../../trace/types.js"
import type { AgentRecord } from "../../types/index.js"
import type { AnalysisResult, RuleResults } from "./types.js"
import { buildAnalysisEvents } from "./adapter.js"
import { detectRepeats, detectRetries, detectDependencies, analyzeLatency } from "./rules.js"
import { detectScriptExtractions } from "./script-extraction.js"
import { buildProposals, buildReport } from "./report-builder.js"
import { assessOverallIntegrity } from "./evidence.js"

/**
 * 确定性分析主函数
 *
 * @param store TraceStore 实例
 * @param runId Run ID
 * @param manifest Trace Manifest
 * @param agents 真实 AgentRecord 数组（缺失时标 unknown）
 * @param generatedAt 外部注入的时间戳（保证纯函数确定性）
 * @param runAttemptId P3.2: Run 执行轮次 ID（Resume 隔离，传给 TraceStore 定位 attempt 目录）
 * @returns AnalysisResult（含 ruleResults + proposals + analysisStatus）
 */
export function analyzeRun(
  store: TraceStore,
  runId: string,
  manifest: TraceManifest,
  agents: AgentRecord[],
  generatedAt: number,
  runAttemptId?: string,
): AnalysisResult {
  // 适配层：合并 ToolCallEvent + Agent 元数据
  const events = buildAnalysisEvents(store, runId, manifest, agents, runAttemptId)

  // 五类规则
  const ruleResults: RuleResults = {
    repeats: detectRepeats(events),
    retries: detectRetries(events),
    dependencies: detectDependencies(events),
    latency: analyzeLatency(events, agents),
    scriptExtractions: detectScriptExtractions(events),
  }

  // 证据评估 + Proposal 生成（只有 script-extraction 自动生成）
  const proposals = buildProposals(runId, manifest.runAttemptId, ruleResults, events)
  const overallIntegrity = assessOverallIntegrity(events)

  const result: AnalysisResult = {
    runId,
    runAttemptId: manifest.runAttemptId,
    ruleResults,
    proposals,
    overallIntegrity,
    generatedAt,
    analysisMode: "deterministic",
    analysisStatus: "completed",
  }

  // 生成报告并写入磁盘（P3.2: 写入 attempt 目录）
  const report = buildReport(result, generatedAt)
  store.writeAnalysis(runId, report.reportMd, report.proposalsJson, runAttemptId)

  return result
}

// 导出子模块（供 DevJobManager 和测试使用）
export { buildAnalysisEvents } from "./adapter.js"
export { detectRepeats, detectRetries, detectDependencies, analyzeLatency, stableStringify, signature } from "./rules.js"
export { detectScriptExtractions, assessDeterminism, extractHeredoc } from "./script-extraction.js"
export { buildProposals, buildReport, occurrenceId, candidateFingerprint } from "./report-builder.js"
export { assessIntegrity, assessConfidence, assessOverallIntegrity } from "./evidence.js"
export type {
  AnalysisToolEvent,
  AnalysisResult,
  Proposal,
  RuleResults,
  RepeatObservation,
  RetryObservation,
  DependencyObservation,
  LatencyAnalysis,
  ScriptExtractionCandidate,
  DeterminismAssessment,
  EvidenceIntegrity,
  CandidateConfidence,
  EvidenceRef,
} from "./types.js"
