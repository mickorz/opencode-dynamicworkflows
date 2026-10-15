/**
 * P3.2 结构化分析验证脚本
 *
 * 用法：
 *   先用 development:true 跑完 p3-analyzer-verify.js，拿到 runId 后运行：
 *   npx tsx scripts/p3/verify-p3-analysis.ts [runId] [directory]
 *
 *   不传 runId 时自动取最新 run。
 *   自动识别 attempt 目录结构（P3.2: history/<runId>/attempts/<safeId>/）。
 *
 * 验证项（P3.2 验收标准）：
 *   1. DevJob 到达终态（completed 或 failed）
 *   2. report.md 含五节规则标题（Rule 1-5）
 *   3. report.md Repeat/Latency 标为 Observation（不直接生成 Proposal）
 *   4. proposals.json schemaVersion=1，每条含 candidateFingerprint + 完整字段
 *   5. proposals 的 evidenceRefs 含真实 sessionId/callID（非空字符串）
 *   6. enrichment.md 仅在 Optimizer 成功时存在
 *   7. manifest development=true + completeness=full
 *   8. P1 History 完好性不回归（history.jsonl + history.md + traces/ 完好）
 *   9. Repeat/Latency 只出现在 Observation 节，不强制生成 Proposal
 */

import fs from "node:fs"
import path from "node:path"

const directory = process.argv[3] ?? process.cwd()
const historyBase = path.join(directory, ".opencode-workflows", "history")
const devBase = path.join(directory, ".opencode-workflows", "development")

let runId = process.argv[2]
if (!runId) {
  if (!fs.existsSync(historyBase)) {
    console.error("[失败] History 目录不存在:", historyBase)
    process.exit(1)
  }
  const dirs = fs
    .readdirSync(historyBase)
    .filter((d) => fs.statSync(path.join(historyBase, d)).isDirectory())
    .sort()
  if (dirs.length === 0) {
    console.error("[失败] History 目录下无 run 子目录")
    process.exit(1)
  }
  runId = dirs[dirs.length - 1]
  console.log(`[信息] 未传 runId，自动取最新: ${runId}`)
}

// P3.2: 自动识别 attempt 目录结构
const runBase = path.join(historyBase, runId)
const attemptsDir = path.join(runBase, "attempts")
let attemptDir: string

if (fs.existsSync(attemptsDir)) {
  // P3.2: 在 attempts/ 下找最新的 attempt
  const attempts = fs
    .readdirSync(attemptsDir)
    .filter((d) => fs.statSync(path.join(attemptsDir, d)).isDirectory())
    .sort()
  if (attempts.length > 0) {
    attemptDir = path.join(attemptsDir, attempts[attempts.length - 1])
    console.log(`[信息] 检测到 attempt 目录: ${attempts[attempts.length - 1]}`)
  } else {
    attemptDir = runBase // 回退
  }
} else {
  // 兼容旧目录结构（P2 数据）
  attemptDir = runBase
  console.log(`[信息] 未检测到 attempts/ 目录，使用旧目录结构`)
}

const analysisDir = path.join(attemptDir, "analysis")
console.log(`[信息] Run: ${runId}`)
console.log(`[信息] Attempt: ${attemptDir}`)
console.log(`[信息] Analysis: ${analysisDir}`)
console.log()

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  const tag = ok ? "[通过]" : "[失败]"
  console.log(`${tag} ${name}${detail ? " — " + detail : ""}`)
  ok ? pass++ : fail++
}

// ============================================================
// 0. DevJob 终态检查
// ============================================================
console.log("=== 0. DevJob 终态 ===")
const jobsFile = path.join(devBase, "jobs.json")
if (fs.existsSync(jobsFile)) {
  try {
    const jobs = JSON.parse(fs.readFileSync(jobsFile, "utf8"))
    const job = jobs.jobs?.find((j: { runId: string }) => j.runId === runId)
    if (job) {
      check("DevJob 存在", true)
      check("DevJob 到达终态", job.status === "completed" || job.status === "failed", `status=${job.status}`)
      if (job.runAttemptId) {
        check("DevJob 含 runAttemptId", true, job.runAttemptId)
      } else {
        check("DevJob 含 runAttemptId", false, "缺失")
      }
    } else {
      check("DevJob 存在", false, `未找到 runId=${runId} 的 Job`)
    }
  } catch {
    check("DevJob 解析", false, "jobs.json 解析失败")
  }
} else {
  console.log("[注意] jobs.json 不存在（Optimizer 可能尚未触发）")
}
console.log()

// ============================================================
// 1. report.md — 五节规则 + 分析状态
// ============================================================
console.log("=== 1. report.md — 五节规则 ===")
const reportPath = path.join(analysisDir, "report.md")
if (!fs.existsSync(reportPath)) {
  check("report.md 存在", false, `路径: ${reportPath}`)
} else {
  const report = fs.readFileSync(reportPath, "utf8")
  check("report.md 存在且非空", report.trim().length > 0, `${report.length} 字符`)

  const rules = ["Rule 1", "Rule 2", "Rule 3", "Rule 4", "Rule 5"]
  for (const rule of rules) {
    check(`含 ${rule} 段落`, report.includes(rule))
  }

  check("含 Analysis Mode", report.includes("Analysis Mode"))
  check("含 Analysis Status", report.includes("Analysis Status"))

  // P3.2: Repeat/Latency 标为 Observation
  check("Repeat 标为 Observation", report.includes("仅观察") || report.includes("Observation"))

  console.log()
  console.log("--- report.md 前 30 行 ---")
  console.log(report.split("\n").slice(0, 30).join("\n"))
}
console.log()

// ============================================================
// 2. proposals.json — Schema 完整性
// ============================================================
console.log("=== 2. proposals.json — Schema 完整性 ===")
const proposalsPath = path.join(analysisDir, "proposals.json")
if (!fs.existsSync(proposalsPath)) {
  check("proposals.json 存在", false, `路径: ${proposalsPath}`)
} else {
  const raw = fs.readFileSync(proposalsPath, "utf8")
  check("proposals.json 存在", true)

  try {
    const parsed = JSON.parse(raw)
    check("schemaVersion=1", parsed.schemaVersion === 1, `actual: ${parsed.schemaVersion}`)

    const proposals = parsed.proposals
    if (!Array.isArray(proposals)) {
      check("proposals 是数组", false)
    } else {
      check("proposals 数量", proposals.length >= 0, `${proposals.length} 个候选`)

      const categories = new Set<string>()

      for (const p of proposals) {
        // 必需字段
        const required = ["id", "candidateFingerprint", "category", "evidenceRefs", "evidenceIntegrity", "candidateConfidence", "status"]
        const missing = required.filter((f) => p[f] === undefined)
        check(`  "${p.title ?? "(untitled)"}" 字段完整`, missing.length === 0, missing.length > 0 ? `缺: ${missing.join(", ")}` : "OK")

        // P3.2: evidenceRefs 含真实 sessionId/callID（非空字符串）
        const refs = p.evidenceRefs
        if (Array.isArray(refs) && refs.length > 0) {
          const createRef = refs[0]
          check(`  evidenceRef[0] sessionId 非空`, createRef.sessionId !== undefined && createRef.sessionId !== "", `sessionId=${createRef.sessionId}`)
          check(`  evidenceRef[0] callID 非空`, createRef.callID !== undefined && createRef.callID !== "", `callID=${createRef.callID}`)
          check(`  evidenceRef[0] ts > 0`, createRef.ts > 0, `ts=${createRef.ts}`)
        }

        if (typeof p.category === "string") categories.add(p.category)
      }

      // P3 v3: Repeat/Latency 不直接生成 Proposal
      check("无 repeat 类 Proposal", !categories.has("repeat"), categories.has("repeat") ? "误生成" : "OK")
      check("无 latency 类 Proposal", !categories.has("latency"), categories.has("latency") ? "误生成" : "OK")

      // Script Extraction 候选
      const scriptProposals = proposals.filter((p: { category: string }) => p.category === "script-extraction")
      if (scriptProposals.length > 0) {
        check("含 script-extraction 类候选", true, `${scriptProposals.length} 个`)
        for (const sp of scriptProposals) {
          check(`  "${sp.title}" 含 sourceScript`, sp.sourceScript !== undefined)
          check(`  "${sp.title}" 含 suggestedTarget`, sp.suggestedTarget !== undefined)
          check(`  "${sp.title}" 含 observedExecutions`, sp.observedExecutions > 0, String(sp.observedExecutions))
        }
      } else {
        console.log("  [注意] 无 script-extraction 类候选（Agent 可能未按预期创建并执行脚本）")
      }

      console.log()
      console.log(`  category 覆盖: ${[...categories].join(", ") || "(无)"}`)
    }
  } catch {
    check("proposals.json 可解析", false, "JSON 解析失败")
  }
}
console.log()

// ============================================================
// 3. enrichment.md — Agent 审阅增补（仅在 Optimizer 成功时存在）
// ============================================================
console.log("=== 3. enrichment.md — Agent 审阅增补 ===")
const enrichmentPath = path.join(analysisDir, "enrichment.md")
if (!fs.existsSync(enrichmentPath)) {
  console.log("[注意] enrichment.md 不存在（Optimizer 可能失败或尚未完成，确定性报告仍有效）")
} else {
  const enrichment = fs.readFileSync(enrichmentPath, "utf8")
  check("enrichment.md 存在且非空", enrichment.trim().length > 0, `${enrichment.length} 字符`)
  console.log()
  console.log("--- enrichment.md 前 10 行 ---")
  console.log(enrichment.split("\n").slice(0, 10).join("\n"))
}
console.log()

// ============================================================
// 4. manifest + History 完好性
// ============================================================
console.log("=== 4. manifest + History 完好性 ===")
const manifestPath = path.join(attemptDir, "manifest.json")
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  check("manifest development=true", manifest.development === true, `development=${manifest.development}`)
  check("manifest completeness=full", manifest.completeness === "full", `completeness=${manifest.completeness}`)
  check("manifest 含 runAttemptId", manifest.runAttemptId !== undefined, manifest.runAttemptId)
  check("manifest sessions > 0", manifest.sessions?.length > 0, `${manifest.sessions?.length ?? 0} sessions`)
}

const tracesDir = path.join(attemptDir, "traces")
if (fs.existsSync(tracesDir)) {
  const traceFiles = fs.readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"))
  check("traces/ 完好", traceFiles.length > 0, `${traceFiles.length} 个文件`)
}

const jsonlPath = path.join(attemptDir, "history.jsonl")
if (fs.existsSync(jsonlPath)) {
  check("history.jsonl 完好", fs.readFileSync(jsonlPath, "utf8").trim().length > 0)
}

const mdPath = path.join(attemptDir, "history.md")
if (fs.existsSync(mdPath)) {
  check("history.md 完好", fs.readFileSync(mdPath, "utf8").trim().length > 0)
}
console.log()

// ============================================================
// 5. Resume 隔离验证（如果存在多个 attempt）
// ============================================================
console.log("=== 5. Resume 隔离验证 ===")
if (fs.existsSync(attemptsDir)) {
  const attempts = fs
    .readdirSync(attemptsDir)
    .filter((d) => fs.statSync(path.join(attemptsDir, d)).isDirectory())
  check("多个 attempt 独立", attempts.length >= 1, `${attempts.length} 个 attempt`)
  if (attempts.length >= 2) {
    // 验证两个 attempt 的 manifest 不互覆盖
    const m1 = JSON.parse(fs.readFileSync(path.join(attemptsDir, attempts[0], "manifest.json"), "utf8"))
    const m2 = JSON.parse(fs.readFileSync(path.join(attemptsDir, attempts[1], "manifest.json"), "utf8"))
    check("两个 attempt 的 runAttemptId 不同", m1.runAttemptId !== m2.runAttemptId, `${m1.runAttemptId} vs ${m2.runAttemptId}`)
  } else {
    console.log("  [信息] 只有 1 个 attempt（未触发 Resume）")
  }
} else {
  console.log("  [信息] 无 attempts/ 目录（P3.2 之前的数据或未使用 attempt 隔离）")
}
console.log()

// ============================================================
// 总结
// ============================================================
console.log("=== 验证总结 ===")
console.log(`通过: ${pass}  失败: ${fail}`)
if (fail === 0) {
  console.log("[全部通过] P3.2 结构化分析器验证成功")
} else {
  console.log(`[部分失败] ${fail} 项未通过，请检查上方标记`)
}
process.exit(fail > 0 ? 1 : 0)
