/**
 * P3-D Proposal 生成 + 报告生成器
 *
 * buildProposals：从 RuleResults 生成 Proposal[]（只有 script-extraction 自动生成）
 * buildReport：从 AnalysisResult 生成 report.md 和 proposals.json（纯函数）
 *
 * v3 修正：
 *  - Repeat/Latency 不直接生成 Proposal（留给 LLM 审阅）
 *  - Proposal 含 candidateFingerprint（跨 Run 稳定指纹）
 *  - generatedAt 外部注入（保证纯函数确定性）
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { createHash } from "node:crypto"
import type {
  AnalysisToolEvent,
  AnalysisResult,
  RuleResults,
  Proposal,
  EvidenceRef,
  EvidenceIntegrity,
  CandidateConfidence,
  ScriptExtractionCandidate,
} from "./types.js"
import { stableStringify, signature } from "./rules.js"
import { assessIntegrity, assessConfidence, assessOverallIntegrity } from "./evidence.js"

// ============================================================
// Proposal ID 生成
// ============================================================

/**
 * occurrence ID：单次分析中的唯一标识（runId + category + 签名前 8 字符）
 */
export function occurrenceId(runId: string, category: string, sig: string): string {
  return `${runId}:${category}:${sig.slice(0, 8)}`
}

/**
 * candidateFingerprint：跨 Run 版本稳定的候选指纹
 * = sha256(category + ":" + stableStringify(canonicalFields))
 * canonicalFields 只含语义稳定字段（tool、filePath、scriptContent 摘要），
 * 不含 runId、ts 等每次变化的字段
 */
export function candidateFingerprint(
  category: string,
  canonicalFields: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${category}:${stableStringify(canonicalFields)}`)
    .digest("hex")
    .slice(0, 16)
}

// ============================================================
// Proposal 生成
// ============================================================

/**
 * 从 RuleResults 生成 Proposal[]
 *
 * v3 策略：
 *  - script-extraction：唯一自动生成 Proposal 的规则
 *    条件：toolCallCompleted + determinism != unlikely + observedExecutions >= 1
 *  - repeat：不直接生成 Proposal（仅 Observation）
 *  - retry：不直接生成 Proposal（仅 Observation，留给 LLM 审阅）
 *  - dependency：不直接生成 Proposal（仅 Observation）
 *  - latency：不直接生成 Proposal（仅 Observation）
 */
export function buildProposals(
  runId: string,
  runAttemptId: string,
  ruleResults: RuleResults,
  events: AnalysisToolEvent[],
): Proposal[] {
  const proposals: Proposal[] = []

  // 只从 script-extraction 候选生成 Proposal
  for (const candidate of ruleResults.scriptExtractions) {
    // 条件检查
    if (!candidate.toolCallCompleted) continue
    if (candidate.determinism === "unlikely") continue
    if (candidate.observedExecutions < 1) continue

    // 评估证据完整性（P3.1: 直接用 candidate.createEvent，不再查找）
    const integrity = assessIntegrity(candidate.createEvent) as EvidenceIntegrity
    const confidence = assessConfidence(candidate, integrity)

    // 构建证据引用（P3.1: 使用真实 createEvent 数据）
    const evidenceRefs = buildEvidenceRefs(candidate, runAttemptId)

    // 构建签名
    const sig = signature(candidate.sourceTool, {
      filePath: candidate.filePath,
      contentPrefix: candidate.scriptContent.slice(0, 100),
    })

    // 构建候选指纹
    const fingerprint = candidateFingerprint("script-extraction", {
      sourceTool: candidate.sourceTool,
      filePath: candidate.filePath,
      contentHash: createHash("sha256").update(candidate.scriptContent).digest("hex").slice(0, 16),
    })

    proposals.push({
      id: occurrenceId(runId, "script-extraction", sig),
      candidateFingerprint: fingerprint,
      title: `固化脚本：${candidate.filePath ?? "unknown"}`,
      description: `从 ${candidate.sourceTool} 工具调用中发现的临时脚本，被执行 ${candidate.observedExecutions} 次。确定性评估：${candidate.determinism}。`,
      category: "script-extraction",
      targetPath: candidate.filePath,
      suggestedChange: "将临时脚本固化为可复用工具，参数化输入路径",
      evidenceRefs,
      evidenceIntegrity: integrity,
      candidateConfidence: confidence,
      validationPlan: "固化后用相同输入执行，输出应与历史一致",
      estimatedImpact: confidence === "high" ? "medium" : "low",
      status: "suggested",
      sourceScript: candidate.scriptContent,
      suggestedTarget: candidate.filePath,
      observedExecutions: candidate.observedExecutions,
    })
  }

  return proposals
}

/** 构建证据引用列表（P3.1: 使用真实 createEvent 数据，可追溯到原始 Trace） */
function buildEvidenceRefs(
  candidate: ScriptExtractionCandidate,
  runAttemptId: string,
): EvidenceRef[] {
  const refs: EvidenceRef[] = []

  // P3.1: 创建事件的引用 — 使用真实的 sessionId/callID/ts/agentLabel
  const createEvent = candidate.createEvent
  refs.push({
    runAttemptId,
    sessionId: createEvent.sessionId,
    callID: createEvent.callID,
    ts: createEvent.startedAt ?? 0,
    tool: createEvent.tool,
    agentLabel: createEvent.agentLabel,
    note: `脚本创建：${candidate.filePath ?? "unknown"}`,
  })

  // 执行事件的引用
  for (const exec of candidate.executionEvents) {
    refs.push({
      runAttemptId,
      sessionId: exec.sessionId,
      callID: exec.callID,
      ts: exec.startedAt ?? 0,
      tool: exec.tool,
      agentLabel: exec.agentLabel,
      note: `脚本执行：${exec.input.command ?? ""}`,
    })
  }

  // P3.1: 可能提及的事件（不算确认执行，但保留为参考证据）
  for (const possible of candidate.possibleExecutions) {
    refs.push({
      runAttemptId,
      sessionId: possible.sessionId,
      callID: possible.callID,
      ts: possible.startedAt ?? 0,
      tool: possible.tool,
      agentLabel: possible.agentLabel,
      note: `可能提及（未确认执行）：${possible.input.command ?? ""}`,
    })
  }

  return refs
}

// ============================================================
// 报告生成
// ============================================================

/**
 * 从 AnalysisResult 生成 report.md 和 proposals.json（纯函数，无 IO）
 *
 * @param result 分析结果
 * @param generatedAt 外部注入的时间戳（保证相同输入相同输出）
 */
export function buildReport(
  result: AnalysisResult,
  generatedAt: number,
): { reportMd: string; proposalsJson: string } {
  const reportMd = buildReportMd(result, generatedAt)
  const proposalsJson = buildProposalsJson(result, generatedAt)
  return { reportMd, proposalsJson }
}

/** 生成 report.md 内容 */
function buildReportMd(result: AnalysisResult, generatedAt: number): string {
  const lines: string[] = []
  const r = result.ruleResults

  lines.push(`# Development Analysis: ${result.runId}`)
  lines.push("")
  lines.push(`- Generated: ${new Date(generatedAt).toISOString()}`)
  lines.push(`- Analysis Mode: ${result.analysisMode}`)
  lines.push(`- Analysis Status: ${result.analysisStatus}`)
  if (result.errorCode) lines.push(`- Error Code: ${result.errorCode}`)
  if (result.errorMessage) lines.push(`- Error Message: ${result.errorMessage}`)
  lines.push(`- Overall Evidence Integrity: ${result.overallIntegrity}`)
  lines.push(`- Proposals: ${result.proposals.length}`)
  lines.push("")

  // Rule 1: Repeat Detection
  lines.push("## Rule 1: Repeat Detection")
  if (r.repeats.length === 0) {
    lines.push("（无重复操作观察）")
  } else {
    lines.push('（Observation 列表，标注「仅观察，不直接生成 Proposal」）')
    lines.push("")
    for (const obs of r.repeats) {
      lines.push(`- ${obs.tool} ×${obs.count}（签名: ${obs.inputSignature.slice(0, 8)}...）`)
      for (const occ of obs.occurrences) {
        lines.push(`  - ts=${occ.ts}, agent=${occ.agentLabel}, callID=${occ.callID}`)
      }
    }
  }
  lines.push("")

  // Rule 2: Retry Chains
  lines.push("## Rule 2: Retry Chains")
  if (r.retries.length === 0) {
    lines.push("（无失败重试观察）")
  } else {
    lines.push("（Observation 列表 + confidence 分级）")
    lines.push("")
    for (const obs of r.retries) {
      lines.push(`- ${obs.tool} confidence=${obs.confidence}`)
      lines.push(`  - failed: ts=${obs.failedAt}, callID=${obs.failedCallID}${obs.error ? `, error=${obs.error}` : ""}`)
      lines.push(`  - retry: ts=${obs.retryAt}, callID=${obs.retryCallID}`)
    }
  }
  lines.push("")

  // Rule 3: Dependency Chains
  lines.push("## Rule 3: Dependency Chains")
  if (r.dependencies.length === 0) {
    lines.push("（无顺序依赖观察）")
  } else {
    lines.push("（Observation 列表 + 链类型）")
    lines.push("")
    for (const obs of r.dependencies) {
      lines.push(`- chainType: ${obs.chainType}`)
      for (const node of obs.chain) {
        lines.push(`  - ${node.tool} ts=${node.ts}, agent=${node.agentLabel}${node.filePath ? `, file=${node.filePath}` : ""}`)
      }
    }
  }
  lines.push("")

  // Rule 4: Latency Distribution
  lines.push("## Rule 4: Latency Distribution")
  if (r.latency.agents.length === 0) {
    lines.push("（无耗时分析数据）")
  } else {
    lines.push('（per-Agent 耗时 + 空闲间隔 + 标注「仅观察，不直接生成 Proposal」）')
    lines.push("")
    for (const agent of r.latency.agents) {
      lines.push(`- ${agent.agentLabel} (${agent.agentId})`)
      lines.push(`  - durationMs: ${agent.durationMs}`)
      lines.push(`  - firstToolDelayMs: ${agent.firstToolDelayMs}`)
      if (agent.idleGaps.length > 0) {
        lines.push(`  - idleGaps:`)
        for (const gap of agent.idleGaps) {
          lines.push(`    - ${gap.fromCallID} -> ${gap.toCallID}: ${gap.gapMs}ms`)
        }
      }
    }
    lines.push(`- totalMs: ${r.latency.totalMs}`)
  }
  lines.push("")

  // Rule 5: Script Extraction
  lines.push("## Rule 5: Script Extraction")
  if (r.scriptExtractions.length === 0) {
    lines.push("（无脚本固化候选）")
  } else {
    lines.push("（候选列表 + determinism 三档评估 + toolCallCompleted + 执行次数）")
    lines.push("")
    for (const c of r.scriptExtractions) {
      lines.push(`- sourceTool: ${c.sourceTool}`)
      lines.push(`  - filePath: ${c.filePath ?? "unknown"}`)
      lines.push(`  - toolCallCompleted: ${c.toolCallCompleted}`)
      lines.push(`  - observedExecutions: ${c.observedExecutions}`)
      lines.push(`  - determinism: ${c.determinism}`)
      const contentPreview = c.scriptContent.slice(0, 80).replace(/\n/g, "\\n")
      lines.push(`  - scriptPreview: ${contentPreview}...`)
    }
  }
  lines.push("")

  // Proposals
  lines.push("## Proposals")
  if (result.proposals.length === 0) {
    lines.push("（无优化候选）")
  } else {
    for (const p of result.proposals) {
      lines.push(`### ${p.title}`)
      lines.push(`- id: ${p.id}`)
      lines.push(`- candidateFingerprint: ${p.candidateFingerprint}`)
      lines.push(`- category: ${p.category}`)
      if (p.targetPath) lines.push(`- targetPath: ${p.targetPath}`)
      if (p.suggestedChange) lines.push(`- suggestedChange: ${p.suggestedChange}`)
      lines.push(`- evidenceIntegrity: ${p.evidenceIntegrity}`)
      lines.push(`- candidateConfidence: ${p.candidateConfidence}`)
      if (p.validationPlan) lines.push(`- validationPlan: ${p.validationPlan}`)
      lines.push(`- estimatedImpact: ${p.estimatedImpact}`)
      lines.push(`- status: ${p.status}`)
      if (p.observedExecutions !== undefined) lines.push(`- observedExecutions: ${p.observedExecutions}`)
    }
  }

  return lines.join("\n")
}

/** 生成 proposals.json 内容 */
function buildProposalsJson(result: AnalysisResult, generatedAt: number): string {
  const data = {
    schemaVersion: 1,
    runId: result.runId,
    generatedAt,
    analysisMode: result.analysisMode,
    analysisStatus: result.analysisStatus,
    proposals: result.proposals,
  }
  return JSON.stringify(data, null, 2)
}
