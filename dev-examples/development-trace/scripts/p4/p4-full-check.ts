/**
 * P4 全链路状态检查（半实机：真实落盘数据 + 断言）
 *
 * 用法：npx tsx scripts/p4/p4-full-check.ts [阶段] [--strict]
 *   不传阶段 = 全部检查；传 all|aggregation|candidate|ab|approval|apply 只查对应阶段
 *   --strict 产物缺失（无 history/candidates/ab-result/approval/apply-log）算失败，
 *            用于验收封版：要求 P4-A～D 指定产物与状态全部存在且符合预期；
 *            不加时缺失输出 [跳过]（分阶段逐步验收友好）
 *
 * 检查项（按 P4 阶段）：
 *   aggregation：manifest.workflowSource 溯源 + candidates.json 聚合视图
 *   candidate  ：optimization-plan.json + candidate.js + solidified-tool 产物 + 原文件未动
 *   ab         ：ab-result.json 三闸门 + 指标
 *   approval   ：approval-records/<id>.json 可信批准
 *   apply      ：apply-log.jsonl 台账 + 目标文件哈希 == 候选哈希 + 备份存在
 *   state      ：optimization-jobs.json 状态机
 */

import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

const wf = path.join(process.cwd(), ".opencode-workflows")
const phase = process.argv[2] === "--strict" ? "all" : (process.argv[2] ?? "all")
const strict = process.argv.includes("--strict")
const want = (p: string) => phase === "all" || phase === p

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"))
const exists = (p: string) => fs.existsSync(p)

let failures = 0
function check(cond: boolean, ok: string, bad: string) {
  if (cond) console.log(`  [通过] ${ok}`)
  else {
    failures += 1
    console.log(`  [失败] ${bad}`)
  }
}

/** 产物缺失检查：strict 模式算失败（要求指定阶段产物全部存在），普通模式跳过 */
function requireArtifact(cond: boolean, skipped: string, strictBad: string) {
  if (cond) return
  if (strict) {
    failures += 1
    console.log(`  [失败] ${strictBad}`)
  } else {
    console.log(`  [跳过] ${skipped}`)
  }
}

console.log("== P4 全链路状态检查 ==")

// ------------------------------------------------------------
if (want("aggregation")) {
  console.log("[阶段A 聚合]")
  const historyDir = path.join(wf, "history")
  if (!exists(historyDir)) {
    requireArtifact(exists(historyDir), "无 history 目录（尚未跑过 development Workflow）", "无 history 目录：--strict 要求已完成 development 运行")
  } else {
    let fileSources = 0
    for (const runId of fs.readdirSync(historyDir)) {
      const attDir = path.join(historyDir, runId, "attempts")
      if (!exists(attDir)) continue
      for (const att of fs.readdirSync(attDir)) {
        const mPath = path.join(attDir, att, "manifest.json")
        if (!exists(mPath)) continue
        const m = readJson(mPath)
        if (m.development !== true) continue
        check(
          m.workflowSource?.scriptHash !== undefined,
          `${runId}: manifest.workflowSource 已写入（${m.workflowSource?.kind}）`,
          `${runId}: manifest 缺 workflowSource 溯源（P4-0 契约一未生效？dist 是否最新）`,
        )
        if (m.workflowSource?.kind === "file") fileSources += 1
      }
    }
    console.log(`  [信息] file 型溯源 manifest 数：${fileSources}`)

    const candPath = path.join(wf, "development", "aggregated", "candidates.json")
    if (exists(candPath)) {
      const data = readJson(candPath)
      check(data.matchMode === "exact" && data.schemaVersion === 1, "candidates.json schema 正确", "candidates.json schema 异常")
      for (const c of data.candidates ?? []) {
        console.log(
          `  [信息] 候选 fp=${c.fingerprint.slice(0, 8)} occ=${c.occurrenceCount} runs=${c.distinctRunCount} eligible=${c.patchEligible} best=${c.bestConfidence}`,
        )
      }
      check((data.candidates ?? []).length > 0, "存在聚合候选", "无聚合候选（需 >=2 个独立 Run）")
    } else {
      requireArtifact(exists(candPath), "candidates.json 不存在（DevJob 尚未完成触发聚合）", "candidates.json 不存在：--strict 要求聚合已完成")
    }
  }
}

// ------------------------------------------------------------
const jobsPath = path.join(wf, "development", "optimization-jobs.json")
const jobs = exists(jobsPath) ? readJson(jobsPath).jobs : []
const activeJob = jobs.find((j) => j.state !== "applied" && j.state !== "rejected") ?? jobs[jobs.length - 1]

if (want("state") && jobs.length > 0) {
  console.log("[状态机]")
  for (const j of jobs) {
    console.log(`  [信息] ${j.optimizationId} state=${j.state} attempt=${j.optimizationAttempt} target=${j.targetWorkflowPath}`)
  }
}

// ------------------------------------------------------------
if (activeJob && (want("candidate") || want("ab") || want("approval") || want("apply"))) {
  const fpDir = path.join(wf, "candidates", activeJob.candidateFingerprint.slice(0, 8))
  console.log(`[任务 ${activeJob.optimizationId} state=${activeJob.state}]`)

  if (want("candidate")) {
    console.log("[阶段B 候选生成]")
    const planPath = path.join(fpDir, "optimization-plan.json")
    check(exists(planPath), "optimization-plan.json 存在", "缺 optimization-plan.json（generateOptimizationPlan 未执行或失败）")
    if (exists(planPath)) {
      const plan = readJson(planPath)
      check(exists(path.join(fpDir, "candidate.js")), "candidate.js 存在", "缺 candidate.js")
      check(exists(plan.solidifiedTool?.toolPath), "solidified-tool 存在", "缺固化工具文件")
      check(
        exists(activeJob.targetWorkflowPath) &&
          sha(fs.readFileSync(activeJob.targetWorkflowPath, "utf8")) ===
            (activeJob.state === "applied" ? plan.candidateScriptHash : plan.originalScriptHash),
        activeJob.state === "applied" ? "目标文件已是候选版（已应用）" : "原文件未动（仍为基线版）",
        "目标文件哈希与预期不符",
      )
      const candidateText = fs.readFileSync(path.join(fpDir, "candidate.js"), "utf8")
      check(
        candidateText.includes(plan.solidifiedTool.deployRelPath),
        `候选引用固化路径 ${plan.solidifiedTool.deployRelPath}`,
        "候选未引用固化路径",
      )
      const dispatch = (candidateText.match(/\b(?:await\s+)?(?:agent|checkpoint)\s*\(/g) ?? []).length
      check(dispatch >= 1, `候选 dispatch 数 = ${dispatch}（>=1，Runtime 约束）`, `候选 dispatch 数 = ${dispatch}（<1 会被 Runtime 拒绝）`)
      for (const t of plan.targetNodes ?? []) {
        console.log(`  [信息] 目标节点: phase=${t.phase} label=${t.label} type=${t.changeType} callIndex=${t.callIndex}`)
      }
    }
  }

  if (want("ab")) {
    console.log("[阶段C A/B 验证]")
    const abPath = path.join(fpDir, "ab-result.json")
    if (!exists(abPath)) {
      requireArtifact(exists(abPath), "ab-result.json 不存在（验证未执行或 failed）", "ab-result.json 不存在：--strict 要求 A/B 验证已执行")
    } else {
      const r = readJson(abPath)
      console.log(`  [信息] 原版: ${JSON.stringify(r.original)}`)
      console.log(`  [信息] 候选: ${JSON.stringify(r.candidate)}`)
      console.log(`  [信息] ${r.evaluation?.details}`)
      check(
        r.passed === (activeJob.state === "awaiting_approval" || activeJob.state === "applied"),
        `passed=${r.passed} 与 Job 状态 ${activeJob.state} 一致`,
        `passed=${r.passed} 与 Job 状态 ${activeJob.state} 不一致`,
      )
      if (r.passed) {
        check(r.evaluation.functionalEquivalence, "功能等价闸门通过", "功能等价未过")
        check(r.evaluation.isolationSafe, "安全隔离闸门通过", "隔离检测未过")
        check(r.evaluation.benefitPositive, "优化收益闸门通过", "收益未过")
      }
    }
  }

  if (want("approval")) {
    console.log("[阶段D-1 批准记录]")
    const recPath = path.join(wf, "development", "approval-records", `${activeJob.optimizationId}.json`)
    if (!exists(recPath)) {
      requireArtifact(exists(recPath), "approval-record 不存在（尚未 approve）", "approval-record 不存在：--strict 要求已完成人工批准")
    } else {
      const rec = readJson(recPath)
      check(rec.approvalChannel?.startsWith("ask:"), `批准通道 ${rec.approvalChannel}`, "批准通道缺失（非 ask 事件？）")
      check(!!rec.candidateBundleHash && !!rec.abResultHash, "批准绑定 bundle + abResult 哈希", "批准记录哈希绑定不完整")
    }
  }

  if (want("apply")) {
    console.log("[阶段D-2 应用结果]")
    const logPath = path.join(fpDir, "apply-log.jsonl")
    if (!exists(logPath)) {
      requireArtifact(exists(logPath), "apply-log.jsonl 不存在（尚未应用）", "apply-log.jsonl 不存在：--strict 要求候选已应用")
    } else {
      const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      const last = lines[lines.length - 1]
      check(last.applied === true, `台账最后一条 applied=true（ts=${new Date(last.ts).toISOString()}）`, "台账 applied=false")
      const planPath = path.join(fpDir, "optimization-plan.json")
      const plan = readJson(planPath)
      check(
        exists(activeJob.targetWorkflowPath) &&
          sha(fs.readFileSync(activeJob.targetWorkflowPath, "utf8")) === plan.candidateScriptHash,
        "目标 Workflow 已替换为候选哈希",
        "目标 Workflow 哈希 != 候选哈希",
      )
      const projectDir = path.dirname(wf)
      const toolTarget = path.join(projectDir, plan.solidifiedTool.deployRelPath)
      check(exists(toolTarget), `固化工具已部署：${toolTarget}`, `固化工具未部署：${toolTarget}`)
      check(last.backupPaths?.length > 0, `备份存在：${last.backupPaths.join(", ")}`, "无备份记录")
      check(activeJob.state === "applied", "Job 终态 applied", `Job 状态 ${activeJob.state}（应 applied）`)
    }
  }
}

console.log(failures === 0 ? `== 全部通过 ==${strict ? "（strict 模式：指定阶段产物与状态全部存在且符合预期）" : ""}` : `== ${failures} 项失败 ==`)
process.exit(failures === 0 ? 0 : 1)
