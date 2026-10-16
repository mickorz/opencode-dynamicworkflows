/**
 * P4-A 聚合验证脚本（半实机：真实 history 数据 + 真实聚合代码）
 *
 * 用法：npx tsx scripts/p4/verify-p4-aggregation.ts
 * 可选：--cycle 额外执行一次聚合周期（含 Job 创建）
 */
import { runAggregationCycle } from "../../../../src/development/aggregator.js"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const wf = join(process.cwd(), ".opencode-workflows")

// 1. 真实 manifest 的 workflowSource（P4-0 契约一实机证明）
const historyDir = join(wf, "history")
const runIds = existsSync(historyDir) ? readdirSync(historyDir) : []
for (const runId of runIds) {
  const manifestPath = join(historyDir, runId, "attempts")
  if (!existsSync(manifestPath)) continue
  for (const att of readdirSync(manifestPath)) {
    const m = JSON.parse(readFileSync(join(historyDir, runId, "attempts", att, "manifest.json"), "utf8"))
    console.log(`[manifest] ${att}: workflowSource =`, JSON.stringify(m.workflowSource ?? null))
  }
}

// 2. 聚合周期（--cycle 时创建 Job）
const r = runAggregationCycle(wf)
console.log("[candidates]")
for (const c of r.candidates) {
  console.log(
    `  fp=${c.fingerprint.slice(0, 8)} cat=${c.category} occ=${c.occurrenceCount} runs=${c.distinctRunCount} eligible=${c.patchEligible} best=${c.bestConfidence}`,
  )
}
console.log("[createdJobs]", r.createdJobs.map((j) => `${j.optimizationId}(${j.state})`).join(", ") || "无")

const jobsFile = join(wf, "development", "optimization-jobs.json")
if (existsSync(jobsFile)) {
  console.log("[optimization-jobs.json]", JSON.parse(readFileSync(jobsFile, "utf8")).jobs.map((j) => ({ id: j.optimizationId, state: j.state, target: j.targetWorkflowPath })))
}
