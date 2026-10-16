/**
 * P4 验收环境重置
 *
 * 用法：npx tsx scripts/p4/cleanup-p4.ts [--keep-history]
 *
 * 清理项（--keep-history 保留业务 Run 的 history，只重置优化状态）：
 *   development/jobs.json               DevJob 记录
 *   development/optimization-jobs.json  OptimizationJob 状态机
 *   development/aggregated/             聚合候选
 *   development/approval-records/       批准记录
 *   candidates/                         候选产物（含备份与台账）
 *   history/（默认也清，重跑需要干净的 distinctRunCount）
 *   journal/ runs/                      运行快照与日志
 *   p3_validate.py                      Workflow 运行残留（Phase 2 写的临时脚本）
 *   tools/p3_validate.py                应用候选后部署的固化工具（验收"已应用"终态后清理）
 *   scripts/p3/p3-analyzer-verify.js    git checkout 恢复原版（上次验收可能已应用候选版）
 */

import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const dir = process.cwd()
const keepHistory = process.argv.includes("--keep-history")
const rm = (p: string) => {
  const t = path.join(dir, p)
  if (fs.existsSync(t)) {
    fs.rmSync(t, { recursive: true, force: true })
    console.log(`[清理] ${p}`)
  }
}
const rmFile = (p: string) => {
  const t = path.join(dir, p)
  if (fs.existsSync(t)) {
    fs.rmSync(t)
    console.log(`[清理] ${p}`)
  }
}

rm(".opencode-workflows/development/jobs.json")
rm(".opencode-workflows/development/optimization-jobs.json")
rm(".opencode-workflows/development/aggregated")
rm(".opencode-workflows/development/approval-records")
rm(".opencode-workflows/candidates")
if (!keepHistory) {
  rm(".opencode-workflows/history")
  rm(".opencode-workflows/journal")
  rm(".opencode-workflows/runs")
}
rmFile("p3_validate.py")
rmFile("tools/p3_validate.py")
try {
  execFileSync("git", ["checkout", "--", "scripts/p3/p3-analyzer-verify.js"], { cwd: dir, windowsHide: true })
  console.log("[恢复] scripts/p3/p3-analyzer-verify.js 已还原为 git 原版")
} catch {
  console.log("[警告] git checkout 恢复失败（非 git 环境或文件未跟踪），必要时手动还原原版脚本")
}
console.log("[完成] P4 验收环境已重置" + (keepHistory ? "（保留 history）" : ""))
