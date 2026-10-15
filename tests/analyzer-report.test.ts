/**
 * P3-D 报告生成器单元测试
 *
 * 验证：
 *  - report.md 含五节规则标题（Rule 1-5）
 *  - report.md Repeat/Latency 标为 Observation
 *  - proposals.json schemaVersion=1，每条含 candidateFingerprint
 *  - 相同输入相同输出（generatedAt 外部注入）
 *  - 空 AnalysisResult 产出最小报告不报错
 *  - analysisStatus=completed 时 report 标注 Analysis Mode + Analysis Status
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildReport,
  buildProposals,
  occurrenceId,
  candidateFingerprint,
} from "../src/development/analyzer/report-builder.js"
import { detectRepeats, detectRetries, detectDependencies, analyzeLatency } from "../src/development/analyzer/rules.js"
import { detectScriptExtractions } from "../src/development/analyzer/script-extraction.js"
import { assessOverallIntegrity } from "../src/development/analyzer/evidence.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import type { AnalysisResult, RuleResults } from "../src/development/analyzer/types.js"

/** 构造完整 AnalysisResult */
function makeAnalysisResult(events: ReturnType<typeof FIXTURES.empty>): AnalysisResult {
  const ruleResults: RuleResults = {
    repeats: detectRepeats(events),
    retries: detectRetries(events),
    dependencies: detectDependencies(events),
    latency: analyzeLatency(events, []),
    scriptExtractions: detectScriptExtractions(events),
  }
  const proposals = buildProposals("run-test", "run-test:abc", ruleResults, events)
  const overallIntegrity = assessOverallIntegrity(events)

  return {
    runId: "run-test",
    runAttemptId: "run-test:abc",
    ruleResults,
    proposals,
    overallIntegrity,
    generatedAt: 1718472000000,
    analysisMode: "deterministic",
    analysisStatus: "completed",
  }
}

test("report.md 含五节规则标题（Rule 1-5）", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)
  const { reportMd } = buildReport(result, 1718472000000)

  assert.ok(reportMd.includes("## Rule 1: Repeat Detection"), "应有 Rule 1")
  assert.ok(reportMd.includes("## Rule 2: Retry Chains"), "应有 Rule 2")
  assert.ok(reportMd.includes("## Rule 3: Dependency Chains"), "应有 Rule 3")
  assert.ok(reportMd.includes("## Rule 4: Latency Distribution"), "应有 Rule 4")
  assert.ok(reportMd.includes("## Rule 5: Script Extraction"), "应有 Rule 5")
})

test("report.md 标注 Analysis Mode + Analysis Status", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)
  const { reportMd } = buildReport(result, 1718472000000)

  assert.ok(reportMd.includes("Analysis Mode: deterministic"), "应标注 Analysis Mode")
  assert.ok(reportMd.includes("Analysis Status: completed"), "应标注 Analysis Status")
})

test("report.md Repeat/Latency 标为 Observation 不直接生成 Proposal", () => {
  const events = FIXTURES.repeatSameRead()
  const result = makeAnalysisResult(events)
  const { reportMd } = buildReport(result, 1718472000000)

  // Repeat 段应含 Observation 标注
  assert.ok(reportMd.includes("仅观察，不直接生成 Proposal"), "应标注仅观察")

  // proposals 中不应有 repeat 或 latency 类
  assert.ok(!result.proposals.some((p) => p.category === "repeat"), "不应有 repeat 类 Proposal")
  assert.ok(!result.proposals.some((p) => p.category === "latency"), "不应有 latency 类 Proposal")
})

test("proposals.json schemaVersion=1", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)
  const { proposalsJson } = buildReport(result, 1718472000000)

  const parsed = JSON.parse(proposalsJson)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.runId, "run-test")
})

test("proposals.json 每条含 candidateFingerprint", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)
  const { proposalsJson } = buildReport(result, 1718472000000)

  const parsed = JSON.parse(proposalsJson)
  assert.ok(parsed.proposals.length > 0, "应至少有 1 个 Proposal")

  for (const p of parsed.proposals) {
    assert.ok(p.id, "应有 id")
    assert.ok(p.candidateFingerprint, "应有 candidateFingerprint")
    assert.equal(typeof p.candidateFingerprint, "string")
    assert.equal(p.candidateFingerprint.length, 16, "fingerprint 应为 16 字符")
    assert.ok(p.category, "应有 category")
    assert.ok(p.evidenceRefs, "应有 evidenceRefs")
    assert.ok(p.evidenceIntegrity, "应有 evidenceIntegrity")
    assert.ok(p.candidateConfidence, "应有 candidateConfidence")
  }
})

test("proposals.json script-extraction Proposal 含 sourceScript + suggestedTarget", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)
  const { proposalsJson } = buildReport(result, 1718472000000)

  const parsed = JSON.parse(proposalsJson)
  const scriptProposal = parsed.proposals.find((p: { category: string }) => p.category === "script-extraction")
  assert.ok(scriptProposal, "应有 script-extraction 类 Proposal")
  assert.ok(scriptProposal.sourceScript, "应有 sourceScript")
  assert.ok(scriptProposal.suggestedTarget, "应有 suggestedTarget")
  assert.ok(scriptProposal.observedExecutions > 0, "应有 observedExecutions > 0")
})

test("相同输入相同输出（generatedAt 外部注入）", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)

  const r1 = buildReport(result, 1718472000000)
  const r2 = buildReport(result, 1718472000000)

  assert.equal(r1.reportMd, r2.reportMd, "相同 generatedAt 应产出相同 report.md")
  assert.equal(r1.proposalsJson, r2.proposalsJson, "相同 generatedAt 应产出相同 proposals.json")
})

test("不同 generatedAt 产出不同报告", () => {
  const events = FIXTURES.scriptExtraction()
  const result = makeAnalysisResult(events)

  const r1 = buildReport(result, 1718472000000)
  const r2 = buildReport(result, 1718472001000)

  assert.notEqual(r1.reportMd, r2.reportMd, "不同 generatedAt 应产出不同 report.md")
})

test("空 AnalysisResult 产出最小报告不报错", () => {
  const result: AnalysisResult = {
    runId: "run-empty",
    runAttemptId: "run-empty:abc",
    ruleResults: {
      repeats: [],
      retries: [],
      dependencies: [],
      latency: { agents: [], totalMs: 0 },
      scriptExtractions: [],
    },
    proposals: [],
    overallIntegrity: "missing",
    generatedAt: 1718472000000,
    analysisMode: "deterministic",
    analysisStatus: "completed",
  }

  const { reportMd, proposalsJson } = buildReport(result, 1718472000000)
  assert.ok(reportMd.includes("Rule 1"), "空结果也应含 Rule 1 标题")
  assert.ok(reportMd.includes("Rule 5"), "空结果也应含 Rule 5 标题")

  const parsed = JSON.parse(proposalsJson)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.proposals.length, 0)
})

test("analysisStatus=failed 时 report 标注失败状态", () => {
  const result: AnalysisResult = {
    runId: "run-failed",
    runAttemptId: "",
    ruleResults: {
      repeats: [],
      retries: [],
      dependencies: [],
      latency: { agents: [], totalMs: 0 },
      scriptExtractions: [],
    },
    proposals: [],
    overallIntegrity: "missing",
    generatedAt: 1718472000000,
    analysisMode: "deterministic",
    analysisStatus: "failed",
    errorCode: "ManifestNotFound",
    errorMessage: "manifest not found",
  }

  const { reportMd } = buildReport(result, 1718472000000)
  assert.ok(reportMd.includes("Analysis Status: failed"), "应标注 failed 状态")
  assert.ok(reportMd.includes("Error Code: ManifestNotFound"), "应标注 errorCode")
  assert.ok(reportMd.includes("manifest not found"), "应标注 errorMessage")
})

// ============================================================
// ID 生成函数测试
// ============================================================

test("occurrenceId 格式正确", () => {
  const id = occurrenceId("run-test", "script-extraction", "abcdef1234567890")
  assert.equal(id, "run-test:script-extraction:abcdef12")
})

test("candidateFingerprint 稳定（相同输入相同输出）", () => {
  const fp1 = candidateFingerprint("script-extraction", { filePath: "test.py", tool: "write" })
  const fp2 = candidateFingerprint("script-extraction", { filePath: "test.py", tool: "write" })
  assert.equal(fp1, fp2)
})

test("candidateFingerprint 不同输入不同输出", () => {
  const fp1 = candidateFingerprint("script-extraction", { filePath: "test.py", tool: "write" })
  const fp2 = candidateFingerprint("script-extraction", { filePath: "other.py", tool: "write" })
  assert.notEqual(fp1, fp2)
})

test("candidateFingerprint 键顺序无关", () => {
  const fp1 = candidateFingerprint("script-extraction", { filePath: "test.py", tool: "write" })
  const fp2 = candidateFingerprint("script-extraction", { tool: "write", filePath: "test.py" })
  assert.equal(fp1, fp2, "键顺序不同但内容相同应产出相同指纹")
})
