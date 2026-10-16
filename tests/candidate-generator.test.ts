/**
 * P4-B 候选生成器单元测试
 *
 * 验证：
 *  - extractCallAt：括号配对提取 agent(...) 完整调用（含 await/嵌套括号/字符串内括号）
 *  - 生成：原文件不动、两份产物落盘、plan 三方绑定
 *  - 写节点收窄（prompt 替换）+ 执行节点路径替换
 *  - 候选合法性：语法校验、dispatch 数 >= 1、固化路径引用
 *  - 基线不符拒绝；write 节点歧义拒绝；非 script-extraction 拒绝
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { writeFileSync, mkdirSync } from "node:fs"
import {
  generateOptimizationPlan,
  CandidateGenerationError,
  extractCallAt,
  countDispatchCalls,
} from "../src/development/candidate-generator.js"
import { sha256Text } from "../src/development/workflow-source.js"
import type { AggregatedCandidate } from "../src/development/aggregator.js"
import type { OptimizationJob } from "../src/development/optimization-job.js"

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-gen-"))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** 与 p3-analyzer-verify.js 同构的样本脚本（write 脚本 + 执行脚本两个 agent 调用） */
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
    state: "aggregated",
    lastUpdatedTs: Date.now(),
  }
}

/** 准备目录：原脚本 + workflows 根 */
function setup(dir: string): { scriptPath: string; scriptHash: string; workflowsDir: string } {
  const scriptPath = path.join(dir, "scripts", "wf.js")
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, SAMPLE_SCRIPT, "utf8")
  const workflowsDir = path.join(dir, ".opencode-workflows")
  mkdirSync(workflowsDir, { recursive: true })
  return { scriptPath, scriptHash: sha256Text(SAMPLE_SCRIPT), workflowsDir }
}

// ============================================================
// extractCallAt / countDispatchCalls
// ============================================================

test("extractCallAt：提取完整调用文本（含嵌套括号与字符串内括号）", () => {
  const script = `const a = await agent("含 (括号) 的 prompt", { label: "x" })\nconst b = await agent("第二个", { label: "y" })`
  const first = extractCallAt(script, 0)
  const second = extractCallAt(script, 1)
  assert.ok(first)
  assert.ok(second)
  assert.ok(first.text.startsWith("await agent("), "含 await 前缀（替换锚点更长更唯一）")
  assert.ok(first.text.endsWith(")"))
  assert.ok(first.text.includes("含 (括号) 的 prompt"), "字符串内的括号不破坏配对")
  assert.ok(second?.text.includes("第二个"))
  assert.equal(extractCallAt(script, 2), null)
  assert.equal(countDispatchCalls(script), 2)
})

test("extractCallAt：checkpoint 也计入 dispatch", () => {
  const script = `await checkpoint("确认", { title: "t" })`
  assert.equal(countDispatchCalls(script), 1)
  assert.ok(extractCallAt(script, 0)?.text.includes("确认"))
})

// ============================================================
// generateOptimizationPlan
// ============================================================

test("生成：两份产物落盘，原文件不动，plan 含三方绑定", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, scriptHash, workflowsDir } = setup(dir)
    const plan = generateOptimizationPlan({
      candidate: makeCandidate(),
      job: makeJob(scriptPath, scriptHash),
      workflowsDir,
    })

    // 原文件不动
    assert.equal(fs.readFileSync(scriptPath, "utf8"), SAMPLE_SCRIPT)
    // 产物落盘
    const outDir = path.join(workflowsDir, "candidates", "4b3fa726")
    assert.ok(fs.existsSync(path.join(outDir, "solidified-tool.py")))
    assert.ok(fs.existsSync(path.join(outDir, "candidate.js")))
    assert.ok(fs.existsSync(path.join(outDir, "optimization-plan.json")))
    // plan 字段
    assert.equal(plan.originalScriptHash, scriptHash)
    assert.ok(plan.candidateScriptHash.length === 64)
    assert.equal(plan.solidifiedTool.toolContent, "import json\nprint('ok')")
    assert.equal(plan.solidifiedTool.parameterized, false, "无 sys.argv")
    assert.equal(plan.solidifiedTool.hasFunctionWrapper, false)
    // targetNodes：write + execute 两个，callIndex 三方绑定
    assert.equal(plan.targetNodes.length, 2)
    assert.equal(plan.targetNodes[0].label, "脚本写入")
    assert.equal(plan.targetNodes[0].callIndex, 0)
    assert.equal(plan.targetNodes[0].phase, "写入脚本")
    assert.equal(plan.targetNodes[0].resultKey, "writeResult")
    assert.equal(plan.targetNodes[1].label, "脚本执行")
    assert.equal(plan.targetNodes[1].callIndex, 1)
    // 改动描述非固定模板（基于实际代码特征）
    assert.match(plan.targetNodes[0].description, /需补充参数化/)
  })()
})

test("生成：写节点替换为零 token check，执行节点路径替换，语法合法", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, scriptHash, workflowsDir } = setup(dir)
    const plan = generateOptimizationPlan({
      candidate: makeCandidate(),
      job: makeJob(scriptPath, scriptHash),
      workflowsDir,
    })
    const candidate = fs.readFileSync(plan.candidateScriptPath, "utf8")

    // 写节点：agent 调用整体替换为 check(commandSuccess)（赋值变量保留）
    assert.ok(!candidate.includes("用 write 工具在当前工作目录创建文件"), "写脚本 Agent 调用已被替换")
    assert.ok(candidate.includes("await check(() => commandSuccess("), "替换为确定性 check（零 token）")
    assert.ok(candidate.includes("const writeResult = await check"), "赋值变量保留（语法完整）")
    // 执行节点：路径替换为固化工具（复用原命令含真实输入文件）
    assert.ok(!candidate.includes("python p3_validate.py "), "临时路径已替换")
    assert.ok(candidate.includes("python tools/p3_validate.py opencode.json"), "实际命令复用并替换路径")
    // 语法合法 + dispatch 数减一但仍 >= 1
    assert.equal(countDispatchCalls(candidate), 1, "agent 调用数 2 -> 1（replace-with-tool）")
    // resultKey 记录（A/B 对比剔除用）
    assert.equal(plan.targetNodes[0].resultKey, "writeResult")
    assert.equal(plan.targetNodes[0].changeType, "replace-with-tool")
  })()
})

test("生成：基线哈希不符拒绝", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, workflowsDir } = setup(dir)
    assert.throws(
      () =>
        generateOptimizationPlan({
          candidate: makeCandidate(),
          job: makeJob(scriptPath, "tampered-hash"),
          workflowsDir,
        }),
      (e: unknown) => e instanceof CandidateGenerationError && /哈希与 Job 基线不符/.test(e.message),
    )
  })()
})

test("生成：write 节点歧义（两处创建同文件）拒绝自动 Patch", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, scriptHash, workflowsDir } = setup(dir)
    const ambiguous = SAMPLE_SCRIPT.replace(
      "return { writeResult, verifyResult }",
      `const extra = await agent("用 write 工具再次创建文件 p3_validate.py", { label: "重复写入" })\nreturn { writeResult, verifyResult, extra }`,
    )
    writeFileSync(scriptPath, ambiguous, "utf8")
    assert.throws(
      () =>
        generateOptimizationPlan({
          candidate: makeCandidate(),
          job: makeJob(scriptPath, sha256Text(ambiguous)),
          workflowsDir,
        }),
      (e: unknown) => e instanceof CandidateGenerationError && /歧义/.test(e.message),
    )
  })()
})

test("生成：非 script-extraction 类别拒绝（第一版单一场景）", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, scriptHash, workflowsDir } = setup(dir)
    const candidate = { ...makeCandidate(), category: "repeat" as const }
    assert.throws(
      () => generateOptimizationPlan({ candidate, job: makeJob(scriptPath, scriptHash), workflowsDir }),
      (e: unknown) => e instanceof CandidateGenerationError && /仅支持 script-extraction/.test(e.message),
    )
  })()
})

test("生成：脚本中无目标文件名引用时拒绝（定位失败转人工）", async () => {
  await withTempDir(async (dir) => {
    const { scriptPath, scriptHash, workflowsDir } = setup(dir)
    const unrelated = SAMPLE_SCRIPT.split("p3_validate.py").join("other_name.py")
    writeFileSync(scriptPath, unrelated, "utf8")
    assert.throws(
      () =>
        generateOptimizationPlan({
          candidate: makeCandidate(),
          job: makeJob(scriptPath, sha256Text(unrelated)),
          workflowsDir,
        }),
      (e: unknown) => e instanceof CandidateGenerationError && /未定位到/.test(e.message),
    )
  })()
})
