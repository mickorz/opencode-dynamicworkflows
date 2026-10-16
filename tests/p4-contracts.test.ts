/**
 * P4-0 四类契约单元测试
 *
 * 契约一 WorkflowSource：kind 判定 + 哈希 + manifest 写入
 * 契约二 ABExecutor/ABEvaluator：非隔离拒绝 + finally 拆除 + 三闸门评估
 * 契约三 ApprovalRecord：持久化往返 + 无记录拒绝
 * 契约四 Candidate Bundle Apply：多文件事务（预检查/备份/部署/验证/恢复）
 * 状态机：optimizationId 稳定 + 活跃/终态判定
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { writeFile, mkdir } from "node:fs/promises"
import { computeWorkflowSource, sha256Text } from "../src/development/workflow-source.js"
import {
  ApprovalStore,
  applyCandidate,
  bundleHash,
  type ApprovalRecord,
  type ApplyTarget,
} from "../src/development/candidate-apply.js"
import { executeInWorktree, evaluateAB } from "../src/development/ab.js"
import {
  makeOptimizationId,
  isActiveOptimizationState,
  isTerminalOptimizationState,
} from "../src/development/optimization-job.js"
import { createWorktree, type WorktreeInfo } from "../src/isolation/worktree.js"

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-contracts-"))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ============================================================
// 契约一：WorkflowSource
// ============================================================

test("workflowSource：scriptPath 判定 file 并解析绝对路径", () => {
  const dir = path.join(os.tmpdir(), "p4-ws")
  const source = computeWorkflowSource({ scriptPath: "scripts/wf.js" }, dir, "export const meta = {}")
  assert.equal(source.kind, "file")
  assert.equal(source.scriptPath, path.resolve(dir, "scripts/wf.js"))
  assert.equal(source.scriptHash, sha256Text("export const meta = {}"))
})

test("workflowSource：inline 无路径，哈希对齐脚本原文", () => {
  const source = computeWorkflowSource({ script: "export const meta = {}" }, "/x", "export const meta = {}")
  assert.equal(source.kind, "inline")
  assert.equal(source.scriptPath, undefined)
  assert.equal(source.scriptHash, sha256Text("export const meta = {}"))
})

test("workflowSource：file 哈希对齐文件字节（解析文本，非 normalize 后）", () => {
  // 文件含尾随空白时哈希取解析文本原样，保证应用前基线校验可对齐文件
  const content = "export const meta = {}   \n"
  const source = computeWorkflowSource({ scriptPath: "a.js" }, "/x", content)
  assert.equal(source.scriptHash, sha256Text(content))
})

// ============================================================
// 契约二：ABExecutor / ABEvaluator
// ============================================================

function makeWorktree(isolated: boolean): WorktreeInfo {
  return { isolated, cwd: "/fake/worktree", branch: isolated ? "wf/test" : undefined, repoRoot: "/fake" }
}

test("executeInWorktree：非隔离拒绝执行且不拆除", async () => {
  let ran = false
  await assert.rejects(
    executeInWorktree(makeWorktree(false), async (cwd) => {
      ran = true
      return cwd
    }),
    /拒绝在非隔离环境执行/,
  )
  assert.equal(ran, false, "非隔离环境不得执行 run")
})

test("executeInWorktree：真实 worktree 执行后 finally 拆除，失败路径也拆除", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p4-exe-"))
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true })
  git(["init", "-b", "main"])
  git(["config", "user.email", "test@test"])
  git(["config", "user.name", "test"])
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(["add", "."])
  git(["commit", "-m", "init"])
  try {
    const wt = await createWorktree(repo, "p4-ab-exec")
    assert.equal(wt.isolated, true)

    // 成功路径：run 收到 worktree cwd，执行后拆除
    const seenCwd = await executeInWorktree(wt, async (cwd) => cwd)
    assert.equal(seenCwd, wt.cwd)
    assert.ok(!fs.existsSync(wt.cwd), "执行成功后 worktree 已拆除")

    // 失败路径：run 报错也拆除（finally 保证）
    const wt2 = await createWorktree(repo, "p4-ab-exec2")
    await assert.rejects(
      executeInWorktree(wt2, async () => {
        throw new Error("候选执行失败")
      }),
      /候选执行失败/,
    )
    assert.ok(!fs.existsSync(wt2.cwd), "执行失败后 worktree 同样拆除")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("evaluateAB：关键产物一致 + 隔离 + 有收益 -> 三闸门全过", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-ab-"))
  try {
    await mkdir(path.join(dir, "original"), { recursive: true })
    await mkdir(path.join(dir, "candidate"), { recursive: true })
    await writeFile(path.join(dir, "original", "result.json"), '{"status":"ok"}')
    await writeFile(path.join(dir, "candidate", "result.json"), '{"status":"ok"}')

    const hashes = { "keep.txt": sha256Text("v1") }
    const result = await evaluateAB({
      artifactsToCompare: ["result.json"],
      originalArtifactsDir: path.join(dir, "original"),
      candidateArtifactsDir: path.join(dir, "candidate"),
      projectHashesBefore: hashes,
      projectHashesAfter: { ...hashes },
      benefit: { improvement: true, detail: "token -40%" },
    })
    assert.deepEqual(
      { f: result.functionalEquivalence, i: result.isolationSafe, b: result.benefitPositive },
      { f: true, i: true, b: true },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("evaluateAB：候选产出不一致 / 修改原项目 / 无收益证据 -> 分别拦截", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-ab-"))
  try {
    await mkdir(path.join(dir, "original"), { recursive: true })
    await mkdir(path.join(dir, "candidate"), { recursive: true })
    await writeFile(path.join(dir, "original", "result.json"), '{"status":"ok"}')
    await writeFile(path.join(dir, "candidate", "result.json"), '{"status":"ok"}')

    // 1. 候选产物内容不一致
    await writeFile(path.join(dir, "candidate", "result.json"), '{"status":"changed"}')
    const r1 = await evaluateAB({
      artifactsToCompare: ["result.json"],
      originalArtifactsDir: path.join(dir, "original"),
      candidateArtifactsDir: path.join(dir, "candidate"),
      projectHashesBefore: { a: "x" },
      projectHashesAfter: { a: "x" },
      benefit: { improvement: true },
    })
    assert.equal(r1.functionalEquivalence, false)
    assert.match(r1.details, /mismatch/)

    // 2. 候选执行修改了原项目文件
    const r2 = await evaluateAB({
      artifactsToCompare: ["result.json"],
      originalArtifactsDir: path.join(dir, "original"),
      candidateArtifactsDir: path.join(dir, "candidate"),
      projectHashesBefore: { "src/app.py": "h1" },
      projectHashesAfter: { "src/app.py": "h2" },
      benefit: { improvement: true },
    })
    assert.equal(r2.isolationSafe, false)
    assert.match(r2.details, /src\/app\.py/)

    // 3. 无收益证据不放行
    const r3 = await evaluateAB({
      artifactsToCompare: [],
      originalArtifactsDir: path.join(dir, "original"),
      candidateArtifactsDir: path.join(dir, "candidate"),
      projectHashesBefore: {},
      projectHashesAfter: {},
    })
    assert.equal(r3.benefitPositive, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================
// 契约三：ApprovalRecord
// ============================================================

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    optimizationId: "fp123456-a1",
    originalScriptHash: sha256Text("original"),
    candidateBundleHash: "bundle",
    abResultHash: "ab",
    approvedAt: 1718472000000,
    approvalChannel: "checkpoint:test",
    ...overrides,
  }
}

test("approvalStore：save 后 load 往返一致；未保存返回 undefined", async () => {
  return withTempDir(async (dir) => {
    const store = new ApprovalStore(path.join(dir, "approval-records"))
    const record = makeRecord()
    await store.save(record)
    const loaded = await store.load("fp123456-a1")
    assert.deepEqual(loaded, record)
    assert.equal(await store.load("not-exist"), undefined)
  })()
})

// ============================================================
// 契约四：Candidate Bundle Apply（多文件事务）
// ============================================================

interface ApplyFixture {
  dir: string
  record: ApprovalRecord
  target: ApplyTarget
}

/** 构造双文件候选（Workflow JS + 固化工具），返回批准记录与应用目标 */
async function makeApplyFixture(dir: string): Promise<ApplyFixture> {
  const candidates = path.join(dir, "candidates", "fp123456")
  await mkdir(candidates, { recursive: true })
  const workflowContent = "// optimized workflow\nexport const meta = { name: 'opt' }"
  const toolContent = "#!/usr/bin/env python3\nprint('solid')"

  const originalScript = path.join(dir, "scripts", "wf.js")
  const originalTool = path.join(dir, "tools", "validate.py")
  await mkdir(path.dirname(originalScript), { recursive: true })
  await mkdir(path.dirname(originalTool), { recursive: true })
  await writeFile(originalScript, "// original workflow")
  await writeFile(originalTool, "print('old')")

  await writeFile(path.join(candidates, "candidate.js"), workflowContent)
  await writeFile(path.join(candidates, "solidified-tool.py"), toolContent)

  const targets = [
    { sourcePath: path.join(candidates, "candidate.js"), targetPath: originalScript },
    { sourcePath: path.join(candidates, "solidified-tool.py"), targetPath: originalTool },
  ]
  const contents = await Promise.all(targets.map((t) => writeFile2Read(t.sourcePath)))
  const record = makeRecord({
    candidateBundleHash: bundleHash([
      { targetPath: targets[0].targetPath, content: contents[0] },
      { targetPath: targets[1].targetPath, content: contents[1] },
    ]),
  })
  const target: ApplyTarget = {
    targets,
    baselineHashes: {
      [originalScript]: sha256Text("// original workflow"),
      [originalTool]: sha256Text("print('old')"),
    },
    candidateHashes: {
      [originalScript]: sha256Text(workflowContent),
      [originalTool]: sha256Text(toolContent),
    },
    backupDir: path.join(candidates, "backup"),
    applyLogPath: path.join(candidates, "apply-log.jsonl"),
  }
  return { dir, record, target }
}

async function writeFile2Read(p: string): Promise<string> {
  return fs.readFileSync(p, "utf8")
}

test("applyCandidate：多文件事务整体应用成功并写台账", async () => {
  return withTempDir(async (dir) => {
    const { record, target } = await makeApplyFixture(dir)
    const result = await applyCandidate(record, target)
    assert.equal(result.applied, true, result.reason)
    // 全部目标文件变为候选内容
    assert.equal(await readFile2(target.targets[0].targetPath), "// optimized workflow\nexport const meta = { name: 'opt' }")
    assert.equal(await readFile2(target.targets[1].targetPath), "#!/usr/bin/env python3\nprint('solid')")
    // 台账落盘
    const log = await readFile2(target.applyLogPath)
    assert.match(log, /"applied":true/)
    assert.match(log, /"optimizationId":"fp123456-a1"/)
  })()
})

test("applyCandidate：无 ApprovalRecord 拒绝且原文件不变", async () => {
  return withTempDir(async (dir) => {
    const { target } = await makeApplyFixture(dir)
    const result = await applyCandidate(undefined, target)
    assert.equal(result.applied, false)
    assert.match(result.reason!, /无 ApprovalRecord/)
    assert.equal(await readFile2(target.targets[0].targetPath), "// original workflow")
  })()
})

test("applyCandidate：bundle 哈希与批准记录不匹配拒绝", async () => {
  return withTempDir(async (dir) => {
    const { record, target } = await makeApplyFixture(dir)
    const tampered = makeRecord({ ...record, candidateBundleHash: "deadbeef" })
    const result = await applyCandidate(tampered, target)
    assert.equal(result.applied, false)
    assert.match(result.reason!, /不匹配/)
  })()
})

test("applyCandidate：原版基线被外部修改拒绝应用", async () => {
  return withTempDir(async (dir) => {
    const { record, target } = await makeApplyFixture(dir)
    await writeFile(target.targets[0].targetPath, "// modified by someone else")
    const result = await applyCandidate(record, target)
    assert.equal(result.applied, false)
    assert.match(result.reason!, /已被修改/)
  })()
})

test("applyCandidate：部署后校验失败整体恢复原始文件（多文件事务）", async () => {
  return withTempDir(async (dir) => {
    const { record, target } = await makeApplyFixture(dir)
    // 篡改候选哈希预期：部署会成功但第 6 步校验必然失败 -> 触发整体恢复
    const tampered = makeRecord({
      ...record,
      candidateBundleHash: record.candidateBundleHash,
    })
    const badTarget: ApplyTarget = {
      ...target,
      candidateHashes: {
        ...target.candidateHashes,
        [target.targets[1].targetPath]: sha256Text("wrong-expectation"),
      },
    }
    const result = await applyCandidate(tampered, badTarget)
    assert.equal(result.applied, false)
    assert.match(result.reason!, /已回滚全部文件|已从备份恢复/)
    // 两个文件都恢复原状（事务性：不是只恢复失败的那个）
    assert.equal(await readFile2(target.targets[0].targetPath), "// original workflow")
    assert.equal(await readFile2(target.targets[1].targetPath), "print('old')")
  })()
})

async function readFile2(p: string): Promise<string> {
  return fs.readFileSync(p, "utf8")
}

// ============================================================
// 状态机
// ============================================================

test("optimizationId：同目标同轮次稳定，不同轮次或不同目标不同", () => {
  assert.equal(makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 1), "e5f6a7b8-hashwf-a1")
  assert.equal(
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 1),
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 1),
  )
  assert.notEqual(
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 1),
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 2),
  )
  // P0-1：同 fingerprint 不同目标 Workflow 的 Job 必须可区分
  assert.notEqual(
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashwf1", 1),
    makeOptimizationId("e5f6a7b8c9d0e1f2", "hashzzz9", 1),
  )
})

test("状态机：活跃态区间与终态判定", () => {
  for (const s of ["discovered", "aggregated", "planned", "generated", "validating", "awaiting_approval"] as const) {
    assert.equal(isActiveOptimizationState(s), true, s)
    assert.equal(isTerminalOptimizationState(s), false, s)
  }
  for (const s of ["applied", "rejected", "failed"] as const) {
    assert.equal(isActiveOptimizationState(s), false, s)
    assert.equal(isTerminalOptimizationState(s), true, s)
  }
})
