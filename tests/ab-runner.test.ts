/**
 * P4-C ab-runner 单元测试（真实 git worktree + 注入 fake runner）
 *
 * 验证：
 *  - 双侧等价 + 隔离 + 收益 -> passed=true，ab-result.json 落盘
 *  - 候选产物不一致 -> functionalEquivalence=false
 *  - 候选执行修改原项目文件 -> isolationSafe=false
 *  - A/B 在不同 worktree cwd 执行，双 worktree 结束后拆除
 *  - 候选已部署到 worktree B（固化工具 + 候选脚本生效）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { runABValidation, type AbScriptRunner, type AbRunOutcome } from "../src/development/ab-runner.js"
import { generateOptimizationPlan } from "../src/development/candidate-generator.js"
import { sha256Text } from "../src/development/workflow-source.js"
import type { AggregatedCandidate } from "../src/development/aggregator.js"
import type { OptimizationJob } from "../src/development/optimization-job.js"

/** 造一个带一次提交的临时 git 仓库（含 scripts/wf.js 与 opencode.json） */
function makeRepo(script: string): { repo: string; scriptPath: string; workflowsDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p4-abrepo-"))
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true })
  git(["init", "-b", "main"])
  git(["config", "user.email", "test@test"])
  git(["config", "user.name", "test"])
  const scriptPath = path.join(repo, "scripts", "wf.js")
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, script, "utf8")
  writeFileSync(path.join(repo, "opencode.json"), '{"plugin":["x"]}', "utf8")
  git(["add", "."])
  git(["commit", "-m", "init"])
  const workflowsDir = path.join(repo, ".opencode-workflows")
  mkdirSync(workflowsDir, { recursive: true })
  return { repo, scriptPath, workflowsDir }
}

const SAMPLE_SCRIPT = `export const meta = {
  name: "sample_wf",
  description: "样本",
  phases: [{ title: "写入脚本" }, { title: "执行脚本" }],
}

phase("写入脚本")
const writeResult = await agent(
  "用 write 工具在当前工作目录创建文件 p3_validate.py，内容为：\\n" +
    "import json\\n" +
    "print('ok')\\n" +
    "创建完成后报告文件路径",
  { agentType: "general", label: "脚本写入" },
)

phase("执行脚本")
const verifyResult = await agent(
  "用 bash 工具运行命令：python p3_validate.py opencode.json，报告输出内容",
  { agentType: "general", label: "脚本执行" },
)

return { writeResult, verifyResult }
`

function makeCandidate(): AggregatedCandidate {
  return {
    fingerprint: "4b3fa72667955fef",
    category: "script-extraction",
    title: "固化脚本 p3_validate.py",
    occurrences: [
      {
        runId: "run-a",
        runAttemptId: "run-a:att1",
        proposalId: "p1",
        ts: 1,
        confidence: "high",
        integrity: "complete",
        sourceScript: "import json\nprint('ok')",
        suggestedTarget: "p3_validate.py",
        workflowScriptPath: "/p/scripts/wf.js",
        workflowScriptHash: "hash",
        workflowSourceKind: "file",
      },
    ],
    occurrenceCount: 2,
    distinctRunCount: 2,
    aggregatedEvidenceRefs: [],
    bestConfidence: "high",
    patchEligible: true,
  }
}

function makeJob(scriptPath: string, scriptHash: string): OptimizationJob {
  return {
    optimizationId: "4b3fa726-17b9bb-a1",
    candidateFingerprint: "4b3fa72667955fef",
    targetWorkflowPath: scriptPath,
    targetWorkflowHash: scriptHash,
    optimizationAttempt: 1,
    totalTokenUsed: 0,
    tokenBudget: 500_000,
    state: "generated",
    lastUpdatedTs: Date.now(),
  }
}

interface Fixture {
  repo: string
  scriptPath: string
  scriptHash: string
  workflowsDir: string
  plan: ReturnType<typeof generateOptimizationPlan>
  job: OptimizationJob
}

function setup(): Fixture {
  const { repo, scriptPath, workflowsDir } = makeRepo(SAMPLE_SCRIPT)
  const scriptHash = sha256Text(SAMPLE_SCRIPT)
  const plan = generateOptimizationPlan({
    candidate: makeCandidate(),
    job: makeJob(scriptPath, scriptHash),
    workflowsDir,
  })
  return { repo, scriptPath, scriptHash, workflowsDir, plan, job: makeJob(scriptPath, scriptHash) }
}

/** fake runner：两侧返回相同结果；A 侧模拟原版 write agent 创建临时脚本（确定性命令的副作用） */
function makeFakeRunner(overrides: {
  onCandidate?: (cwd: string, script: string) => AbRunOutcome
  originalResult?: unknown
  candidateResult?: unknown
} = {}): AbScriptRunner & { calls: Array<{ cwd: string; script: string }> } {
  const calls: Array<{ cwd: string; script: string }> = []
  return {
    calls,
    run: async (script, cwd) => {
      calls.push({ cwd, script })
      const isCandidate = script.includes("tools/p3_validate.py")
      if (isCandidate && overrides.onCandidate) {
        return overrides.onCandidate(cwd, script)
      }
      if (!isCandidate) {
        // 原版 write agent 的副作用：创建临时脚本（A 侧确定性命令依赖它）
        writeFileSync(path.join(cwd, "p3_validate.py"), "print('ok')", "utf8")
      }
      const result = isCandidate ? overrides.candidateResult : overrides.originalResult
      return {
        status: "completed",
        result: result ?? { writeResult: "ok", verifyResult: "valid" },
        durationMs: isCandidate ? 100 : 200,
        totalTokens: isCandidate ? 50 : 100,
      }
    },
  }
}

test("A/B：双侧等价通过三闸门，产物落盘，双 worktree 拆除", async () => {
  const f = setup()
  try {
    const runner = makeFakeRunner()
    const result = await runABValidation({ workflowsDir: f.workflowsDir, job: f.job, plan: f.plan, runner })

    assert.equal(result.passed, true, result.evaluation.details)
    assert.deepEqual(
      { f: result.evaluation.functionalEquivalence, i: result.evaluation.isolationSafe, b: result.evaluation.benefitPositive },
      { f: true, i: true, b: true },
    )
    // 指标：原版 200ms/100tok，候选 100ms/50tok
    assert.equal(result.original.totalTokens, 100)
    assert.equal(result.candidate.totalTokens, 50)
    // ab-result.json 落盘
    const saved = JSON.parse(fs.readFileSync(result.abResultPath, "utf8"))
    assert.equal(saved.passed, true)
    assert.equal(saved.optimizationId, f.job.optimizationId)
    // A/B 在不同 cwd 执行
    assert.equal(runner.calls.length, 2)
    assert.notEqual(runner.calls[0].cwd, runner.calls[1].cwd)
    // 第一次收到的原版脚本，第二次是候选脚本（含固化路径）
    assert.ok(!runner.calls[0].script.includes("tools/p3_validate.py"))
    assert.ok(runner.calls[1].script.includes("tools/p3_validate.py"))
    // worktree 已拆除（执行目录已消失）
    assert.ok(!fs.existsSync(runner.calls[0].cwd), "worktree A 已拆除")
    assert.ok(!fs.existsSync(runner.calls[1].cwd), "worktree B 已拆除")
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true })
  }
})

test("A/B：候选已部署进 worktree B（固化工具可读，候选脚本生效）", async () => {
  const f = setup()
  try {
    let seenTool: string | null = null
    const runner = makeFakeRunner({
      onCandidate: (cwd, script) => {
        const toolPath = path.join(cwd, "tools", "p3_validate.py")
        seenTool = fs.existsSync(toolPath) ? fs.readFileSync(toolPath, "utf8") : null
        // 候选脚本应已覆盖 worktree B 的 scripts/wf.js
        const deployed = fs.readFileSync(path.join(cwd, "scripts", "wf.js"), "utf8")
        assert.ok(deployed.includes("tools/p3_validate.py"), "worktree B 内脚本为候选版")
        return { status: "completed", result: { writeResult: "ok", verifyResult: "valid" }, durationMs: 100, totalTokens: 50 }
      },
    })
    await runABValidation({ workflowsDir: f.workflowsDir, job: f.job, plan: f.plan, runner })
    assert.equal(seenTool, "import json\nprint('ok')", "固化工具部署在 worktree B 的 tools/ 下")
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true })
  }
})

test("A/B：确定性命令输出不一致 -> 功能等价闸门拦截", async () => {
  const f = setup()
  try {
    const runner = makeFakeRunner({
      onCandidate: (cwd) => {
        // 篡改 B 侧固化工具，输出与 A 侧不同
        writeFileSync(path.join(cwd, "tools", "p3_validate.py"), "print('DIFFERENT')", "utf8")
        return { status: "completed", result: { writeResult: "ok", verifyResult: "valid" }, durationMs: 100, totalTokens: 50 }
      },
    })
    const result = await runABValidation({ workflowsDir: f.workflowsDir, job: f.job, plan: f.plan, runner })
    assert.equal(result.passed, false)
    assert.equal(result.evaluation.functionalEquivalence, false)
    assert.match(result.evaluation.details, /tool-output\.txt/)
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true })
  }
})

test("A/B：候选执行修改原项目 -> 安全隔离闸门拦截", async () => {
  const f = setup()
  try {
    const runner = makeFakeRunner({
      onCandidate: (cwd, script) => {
        // 模拟越界写：直接改原项目的固化工具目标位置
        const outside = path.join(f.repo, "tools", "p3_validate.py")
        mkdirSync(path.dirname(outside), { recursive: true })
        writeFileSync(outside, "tampered", "utf8")
        return { status: "completed", result: { writeResult: "ok", verifyResult: "valid" }, durationMs: 100, totalTokens: 50 }
      },
    })
    const result = await runABValidation({ workflowsDir: f.workflowsDir, job: f.job, plan: f.plan, runner })
    assert.equal(result.passed, false)
    assert.equal(result.evaluation.isolationSafe, false)
    assert.match(result.evaluation.details, /tools[\\/]p3_validate\.py/)
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true })
  }
})

test("A/B：候选无收益（token 与耗时均不降）-> 收益闸门拦截", async () => {
  const f = setup()
  try {
    const runner = makeFakeRunner({
      onCandidate: () => ({ status: "completed", result: { writeResult: "ok", verifyResult: "valid" }, durationMs: 300, totalTokens: 150 }),
    })
    const result = await runABValidation({ workflowsDir: f.workflowsDir, job: f.job, plan: f.plan, runner })
    assert.equal(result.passed, false)
    assert.equal(result.evaluation.benefitPositive, false)
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true })
  }
})
