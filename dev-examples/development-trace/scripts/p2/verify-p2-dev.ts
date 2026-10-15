/**
 * P2 Development Job 与分析报告验证脚本
 *
 * 用法：
 *   先在 OpenCode 中用 development:true 跑完 p2-dev-verify.js，拿到 runId 后运行：
 *   npx tsx scripts/p2/verify-p2-dev.ts <runId> [directory]
 *
 *   不传 runId 时自动取 history 目录下最新的 run。
 *
 * 验证项（对应 P2 验收标准）：
 *   V-12 development:true 的 Run 完成后自动创建 Job
 *   V-13 Job 状态流转 pending -> running -> completed
 *   V-14 analysis/report.md 存在且非空
 *   V-15 analysis/proposals.json 存在且含 proposals
 *   V-16 Optimizer Run 不再触发新 Job（防递归）
 *   V-20 createOnce 幂等：同一 runId 只创建一次
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

const runDir = path.join(historyBase, runId)
console.log(`[信息] 检查 Run: ${runId}`)
console.log(`[信息] History: ${runDir}`)
console.log()

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  const tag = ok ? "[通过]" : "[失败]"
  console.log(`${tag} ${name}${detail ? " — " + detail : ""}`)
  ok ? pass++ : fail++
}

// ============================================================
// 1. jobs.json（Development Job 持久化）
// ============================================================
console.log("=== 1. development/jobs.json ===")
const jobsPath = path.join(devBase, "jobs.json")
if (!fs.existsSync(jobsPath)) {
  check("V-12: jobs.json 存在", false, "文件不存在")
} else {
  const jobFile = JSON.parse(fs.readFileSync(jobsPath, "utf8"))
  const jobs = jobFile.jobs ?? []
  const matchingJobs = jobs.filter((j: { runId: string }) => j.runId === runId)
  check("V-12: jobs.json 存在", true, `${jobs.length} 个 Job 总计`)
  check("V-12: 存在匹配 runId 的 Job", matchingJobs.length >= 1)
  check("V-20: createOnce 幂等（只有 1 个）", matchingJobs.length === 1, `实际: ${matchingJobs.length}`)
  if (matchingJobs.length > 0) {
    const job = matchingJobs[0]
    console.log(`  runId:          ${job.runId}`)
    console.log(`  originRunId:   ${job.originRunId}`)
    console.log(`  optimizerRunId: ${job.optimizerRunId ?? "(none)"}`)
    console.log(`  status:         ${job.status}`)
    console.log(`  createdAt:      ${job.createdAt}`)
    console.log(`  startedAt:      ${job.startedAt ?? "(none)"}`)
    console.log(`  endedAt:        ${job.endedAt ?? "(none)"}`)
    if (job.error) console.log(`  error:          ${job.error}`)
    check("V-13: Job 状态 = completed", job.status === "completed", `actual: ${job.status}`)
    check("V-13: optimizerRunId 非空", !!job.optimizerRunId)
  }
}
console.log()

// ============================================================
// 2. 防递归：Optimizer Run 不产生新 Job
// ============================================================
console.log("=== 2. 防递归 ===")
if (fs.existsSync(jobsPath)) {
  const jobFile = JSON.parse(fs.readFileSync(jobsPath, "utf8"))
  const jobs = jobFile.jobs ?? []
  // Optimizer Run 的 runId 不应出现在 jobs 的 runId 列表中
  const matchingJobs = jobs.filter((j: { runId: string }) => j.runId === runId)
  if (matchingJobs.length > 0) {
    const optimizerRunId = matchingJobs[0].optimizerRunId
    if (optimizerRunId) {
      const optimizerJobs = jobs.filter((j: { runId: string }) => j.runId === optimizerRunId)
      check("V-16: Optimizer Run 无新 Job（防递归）", optimizerJobs.length === 0, `optimizerRunId=${optimizerRunId} 的 Job 数: ${optimizerJobs.length}`)
    } else {
      check("V-16: Optimizer Run 无新 Job", false, "optimizerRunId 为空")
    }
  }
} else {
  check("V-16: 防递归", false, "jobs.json 不存在")
}
console.log()

// ============================================================
// 3. analysis/report.md
// ============================================================
console.log("=== 3. analysis/report.md ===")
const reportPath = path.join(runDir, "analysis", "report.md")
if (!fs.existsSync(reportPath)) {
  check("V-14: report.md 存在", false)
} else {
  const report = fs.readFileSync(reportPath, "utf8")
  check("V-14: report.md 存在且非空", report.trim().length > 0, `${report.length} 字符`)
  if (report.trim().length > 0) {
    console.log()
    console.log("--- report.md 前 20 行 ---")
    console.log(report.split("\n").slice(0, 20).join("\n"))
  }
}
console.log()

// ============================================================
// 4. analysis/proposals.json
// ============================================================
console.log("=== 4. analysis/proposals.json ===")
const proposalsPath = path.join(runDir, "analysis", "proposals.json")
if (!fs.existsSync(proposalsPath)) {
  check("V-15: proposals.json 存在", false)
} else {
  const raw = fs.readFileSync(proposalsPath, "utf8")
  check("V-15: proposals.json 存在", true)
  try {
    const parsed = JSON.parse(raw)
    let proposals: unknown[] = []
    if (Array.isArray(parsed)) {
      proposals = parsed
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.proposals)) {
      proposals = parsed.proposals
    }
    check("V-15: 含 proposals 数组", proposals.length > 0, `${proposals.length} 个候选`)
    if (proposals.length > 0) {
      console.log("  优化候选:")
      for (const p of proposals) {
        const item = p as { title?: string; description?: string; evidence?: unknown }
        console.log(`    - ${item.title ?? "(untitled)"}`)
        if (item.evidence) console.log(`      evidence: ${JSON.stringify(item.evidence).slice(0, 80)}`)
      }
    }
  } catch {
    check("V-15: proposals.json 可解析", false, "JSON 解析失败")
  }
}
console.log()

// ============================================================
// 5. P1 History 仍完好（不回归）
// ============================================================
console.log("=== 5. P1 History 完好性 ===")
const manifestPath = path.join(runDir, "manifest.json")
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  check("manifest.json 完好", manifest.completeness !== undefined, `completeness=${manifest.completeness}`)
}
const jsonlPath = path.join(runDir, "history.jsonl")
if (fs.existsSync(jsonlPath)) {
  const jsonl = fs.readFileSync(jsonlPath, "utf8")
  check("history.jsonl 完好", jsonl.trim().length > 0)
}
const mdPath = path.join(runDir, "history.md")
if (fs.existsSync(mdPath)) {
  check("history.md 完好", fs.readFileSync(mdPath, "utf8").trim().length > 0)
}
console.log()

// ============================================================
// 总结
// ============================================================
console.log("=== 验证总结 ===")
console.log(`通过: ${pass}  失败: ${fail}`)
if (fail === 0) {
  console.log("[全部通过] P2 Development Job 验证成功")
} else {
  console.log(`[部分失败] ${fail} 项未通过，请检查上方标记`)
}
process.exit(fail > 0 ? 1 : 0)
