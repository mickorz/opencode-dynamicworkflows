/**
 * P4-A 跨 Run Exact 聚合单元测试
 *
 * 验证：
 *  - 2 Run 同 fingerprint 聚合：distinctRunCount=2
 *  - Resume 去重：同 runId 多 attempt 算多条证据但不增 distinctRunCount
 *  - 不同 fingerprint 不聚合（Exact Match 限制）
 *  - excludeFingerprints 过滤
 *  - patchEligible：inline 溯源无 Patch 资格
 *  - candidates.json 落盘
 *  - runAggregationCycle：达标创建 Job、幂等防重、跨 Workflow 不创建、
 *    failed 无新证据不重试、新 occurrence 重试 attempt+1、attempt 上限
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import {
  aggregateCandidates,
  runAggregationCycle,
  writeAggregatedCandidates,
} from "../src/development/aggregator.js"
import { OptimizationJobManager } from "../src/development/optimization-jobs.js"

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-agg-"))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ============================================================
// fixture 构造：history/<runId>/attempts/<attemptId>/{manifest.json, analysis/proposals.json}
// ============================================================

interface ProposalFixture {
  id: string
  candidateFingerprint: string
  title: string
  category: string
  candidateConfidence: "high" | "medium" | "low"
  evidenceIntegrity: string
  sourceScript?: string
  suggestedTarget?: string
  evidenceRefs?: Array<{ runAttemptId: string; sessionId: string; callID: string; ts: number; tool: string; agentLabel: string; note: string }>
}

interface AttemptFixture {
  attemptId: string
  workflowSource?: { kind: "file" | "inline"; scriptPath?: string; scriptHash: string }
  proposals: ProposalFixture[]
  generatedAt?: number
}

async function writeRun(
  workflowsDir: string,
  runId: string,
  attempts: AttemptFixture[],
): Promise<void> {
  for (const attempt of attempts) {
    // 目录名与真实 TraceStore 一致：runAttemptId 经 sanitizeForPath（冒号等替换为短横线，Windows 路径段禁冒号）
    const safeId = attempt.attemptId.replace(/[:<>|?*"\\/]/g, "-")
    const dir = path.join(workflowsDir, "history", runId, "attempts", safeId)
    await mkdir(path.join(dir, "analysis"), { recursive: true })
    const manifest: Record<string, unknown> = {
      version: 1,
      runId,
      runAttemptId: attempt.attemptId,
      rootRunId: runId,
      startedAt: 0,
      endedAt: 1,
      status: "completed",
      completeness: "full",
      sessions: [],
      ...(attempt.workflowSource ? { workflowSource: attempt.workflowSource } : {}),
    }
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest))
    await writeFile(
      path.join(dir, "analysis", "proposals.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId,
        generatedAt: attempt.generatedAt ?? 1718472000000,
        analysisMode: "deterministic",
        analysisStatus: "ok",
        proposals: attempt.proposals,
      }),
    )
  }
}

function proposal(o: Partial<ProposalFixture> & { id: string; candidateFingerprint: string }): ProposalFixture {
  return {
    title: "固化脚本 validate.py",
    category: "script-extraction",
    candidateConfidence: "high",
    evidenceIntegrity: "complete",
    sourceScript: "import sys",
    suggestedTarget: "tools/validate.py",
    ...o,
  }
}

const WF_SOURCE = (scriptPath: string, scriptHash = "hash-wf-1") => ({
  kind: "file" as const,
  scriptPath,
  scriptHash,
})
const FP = "e5f6a7b8c9d0e1f2"

// ============================================================
// aggregateCandidates
// ============================================================

test("聚合：2 Run 同 fingerprint 合并，distinctRunCount=2", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/scripts/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: WF_SOURCE("/p/scripts/wf.js"), proposals: [proposal({ id: "p2", candidateFingerprint: FP })] }])

    const candidates = aggregateCandidates(path.join(wf, "history"))
    assert.equal(candidates.length, 1)
    const c = candidates[0]
    assert.equal(c.fingerprint, FP)
    assert.equal(c.occurrenceCount, 2)
    assert.equal(c.distinctRunCount, 2)
    assert.equal(c.patchEligible, true)
    assert.equal(c.category, "script-extraction")
    assert.equal(c.title, "固化脚本 validate.py")
    // occurrence 带溯源
    assert.equal(c.occurrences[0].workflowScriptPath, "/p/scripts/wf.js")
    assert.equal(c.occurrences[0].workflowScriptHash, "hash-wf-1")
  })()
})

test("聚合：Resume 同 runId 多 attempt 不增 distinctRunCount", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [
      { attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] },
      { attemptId: "run-a:att2", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p2", candidateFingerprint: FP })] },
    ])

    const candidates = aggregateCandidates(path.join(wf, "history"))
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].occurrenceCount, 2, "两次 attempt 各算一条证据")
    assert.equal(candidates[0].distinctRunCount, 1, "同一 Run 的 Resume 不增加 distinctRunCount")
  })()
})

test("聚合：不同 fingerprint 不合并（Exact Match）", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p2", candidateFingerprint: "ffffffff00000000" })] }])

    const candidates = aggregateCandidates(path.join(wf, "history"))
    assert.equal(candidates.length, 2)
  })()
})

test("聚合：excludeFingerprints 过滤", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    const candidates = aggregateCandidates(path.join(wf, "history"), { excludeFingerprints: [FP] })
    assert.equal(candidates.length, 0)
  })()
})

test("聚合：inline 溯源无 Patch 资格（只保留建议）", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: { kind: "inline", scriptHash: "h1" }, proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: { kind: "inline", scriptHash: "h1" }, proposals: [proposal({ id: "p2", candidateFingerprint: FP })] }])

    const candidates = aggregateCandidates(path.join(wf, "history"))
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].distinctRunCount, 2)
    assert.equal(candidates[0].patchEligible, false, "内联脚本不可自动 Patch")
    // 无溯源（manifest 缺失）同样无资格
  })()
})

test("聚合：evidenceRefs 去重合并，bestConfidence 取最高", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    const ref = { runAttemptId: "run-a:att1", sessionId: "s1", callID: "c1", ts: 1, tool: "write", agentLabel: "A", note: "n" }
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [
      proposal({ id: "p1", candidateFingerprint: FP, candidateConfidence: "medium", evidenceRefs: [ref, { ...ref, callID: "c2" }] }),
    ] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [
      proposal({ id: "p2", candidateFingerprint: FP, candidateConfidence: "high", evidenceRefs: [ref, { ...ref, runAttemptId: "run-b:att1" }] }),
    ] }])

    const candidates = aggregateCandidates(path.join(wf, "history"))
    const c = candidates[0]
    assert.equal(c.bestConfidence, "high")
    // run-a 的 c1/c2 + run-b 的 run-b:att1:c1（c1 与 run-a 重复已去）
    assert.equal(c.aggregatedEvidenceRefs.length, 3)
  })()
})

test("落盘：candidates.json 结构与往返", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    const candidates = aggregateCandidates(path.join(wf, "history"))
    writeAggregatedCandidates(wf, candidates)

    const raw = JSON.parse(fs.readFileSync(path.join(wf, "development", "aggregated", "candidates.json"), "utf8"))
    assert.equal(raw.schemaVersion, 1)
    assert.equal(raw.matchMode, "exact")
    assert.equal(raw.candidates.length, 1)
    assert.equal(raw.candidates[0].fingerprint, FP)
  })()
})

// ============================================================
// runAggregationCycle：创建 Job 与幂等
// ============================================================

test("周期：2 Run file 型达标创建 1 个 Job，二次执行幂等不重建", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/scripts/wf.js"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: WF_SOURCE("/p/scripts/wf.js"), proposals: [proposal({ id: "p2", candidateFingerprint: FP })] }])

    const first = runAggregationCycle(wf)
    assert.equal(first.createdJobs.length, 1)
    const job = first.createdJobs[0]
    assert.equal(job.candidateFingerprint, FP)
    assert.equal(job.targetWorkflowPath, "/p/scripts/wf.js")
    assert.equal(job.targetWorkflowHash, "hash-wf-1")
    assert.equal(job.state, "aggregated")
    assert.equal(job.optimizationAttempt, 1)
    assert.equal(job.optimizationId, `${FP.slice(0, 8)}-hash-w-a1`)

    // Job 持久化落盘
    const persisted = JSON.parse(fs.readFileSync(path.join(wf, "development", "optimization-jobs.json"), "utf8"))
    assert.equal(persisted.jobs.length, 1)

    // 二次执行：candidates.json 保持全量视图，Job 由 createOnce 幂等返回既有（不新建）
    const second = runAggregationCycle(wf)
    assert.equal(second.candidates.length, 1, "全量视图不因 Job 占用而丢展示")
    assert.equal(second.createdJobs.length, 1)
    assert.equal(second.createdJobs[0].optimizationId, job.optimizationId, "幂等返回同一 Job")

    // optimization-jobs.json 仍只有 1 个 Job（未重复创建）
    const persisted2 = JSON.parse(fs.readFileSync(path.join(wf, "development", "optimization-jobs.json"), "utf8"))
    assert.equal(persisted2.jobs.length, 1)
    // candidates.json 在 development/aggregated/ 层级（文档目录结构）
    assert.ok(fs.existsSync(path.join(wf, "development", "aggregated", "candidates.json")))
  })()
})

test("周期：跨 Workflow 同 fingerprint 不创建（各目标组 distinct=1）", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: WF_SOURCE("/p/scripts/a.js", "hash-a"), proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: WF_SOURCE("/p/scripts/b.js", "hash-b"), proposals: [proposal({ id: "p2", candidateFingerprint: FP })] }])

    const result = runAggregationCycle(wf)
    // 聚合候选存在且达标（整体 distinctRunCount=2）……但 patchEligible 按全组判定为 true
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].distinctRunCount, 2)
    // 按目标 Workflow 分组后每组 distinct=1，不创建 Job
    assert.equal(result.createdJobs.length, 0, "不得把 A Workflow 的 Patch 应用到 B Workflow")
  })()
})

test("周期：inline 不创建 Job；未达标不创建", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    await writeRun(wf, "run-a", [{ attemptId: "run-a:att1", workflowSource: { kind: "inline", scriptHash: "h1" }, proposals: [proposal({ id: "p1", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-b", [{ attemptId: "run-b:att1", workflowSource: { kind: "inline", scriptHash: "h1" }, proposals: [proposal({ id: "p2", candidateFingerprint: FP })] }])
    await writeRun(wf, "run-c", [{ attemptId: "run-c:att1", workflowSource: WF_SOURCE("/p/c.js", "hash-c"), proposals: [proposal({ id: "p3", candidateFingerprint: "aaaaaaaabbbbbbbb" })] }])

    const result = runAggregationCycle(wf)
    assert.equal(result.createdJobs.length, 0)
    assert.equal(result.candidates.length, 2, "候选仍保留在 candidates.json 供人工查看")
  })()
})

// ============================================================
// OptimizationJobManager：failed 重试门槛与 attempt 上限
// ============================================================

test("幂等：failed 终态无新独立 Run 不重建，新 Run 重建 attempt+1", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    const manager = new OptimizationJobManager()
    const j1 = manager.createOnce({
      candidateFingerprint: FP,
      targetWorkflowPath: "/p/wf.js",
      targetWorkflowHash: "hash-1",
      distinctRunCount: 2,
    })
    assert.ok(j1)

    // 失败进入终态，记录当时独立 Run 数 = 2
    manager.updateState(j1.optimizationId, "failed", { distinctRunCountOfTarget: 2 })

    // 无新独立 Run（同 Run 复跑不增长）：不重建
    assert.equal(manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/wf.js", targetWorkflowHash: "hash-1", distinctRunCount: 2 }), undefined)

    // 新独立 Run（3 > 2）：重建 attempt+1
    const j2 = manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/wf.js", targetWorkflowHash: "hash-1", distinctRunCount: 3 })
    assert.ok(j2)
    assert.equal(j2.optimizationAttempt, 2)
    assert.equal(j2.optimizationId, `${FP.slice(0, 8)}-hash-1-a2`)
  })()
})

test("幂等：attempt 达上限 3 后不再重建", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    const manager = new OptimizationJobManager()
    let runs = 2
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/wf.js", targetWorkflowHash: "hash-1", distinctRunCount: runs })
      assert.ok(job, `第 ${attempt} 轮应创建`)
      assert.equal(job.optimizationAttempt, attempt)
      manager.updateState(job.optimizationId, "failed", { distinctRunCountOfTarget: runs })
      runs += 1
    }
    // 第 4 轮：超上限
    assert.equal(
      manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/wf.js", targetWorkflowHash: "hash-1", distinctRunCount: 99 }),
      undefined,
    )
  })()
})

test("幂等：同 fingerprint 不同目标 Workflow 是不同 Job（P0-1）", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    const manager = new OptimizationJobManager()
    const jA = manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/a.js", targetWorkflowHash: "ha1111", distinctRunCount: 2 })
    const jB = manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/b.js", targetWorkflowHash: "hb2222", distinctRunCount: 2 })
    assert.ok(jA && jB)
    assert.notEqual(jA.optimizationId, jB.optimizationId)
    assert.equal(manager.list().length, 2)
  })()
})

test("状态机：updateState 推进与 load 恢复", async () => {
  await withTempDir(async (dir) => {
    const wf = path.join(dir, ".opencode-workflows")
    const manager = new OptimizationJobManager()
    const job = manager.createOnce({ candidateFingerprint: FP, targetWorkflowPath: "/p/wf.js", targetWorkflowHash: "h11111", distinctRunCount: 2 })
    assert.ok(job)
    assert.equal(manager.updateState(job.optimizationId, "planned"), true)
    assert.equal(manager.updateState(job.optimizationId, "generated", { candidateScriptHash: "cs" }), true)
    assert.equal(manager.updateState("no-such", "failed"), false)

    manager.persist(wf)

    // 重启恢复
    const reloaded = new OptimizationJobManager()
    reloaded.load(wf)
    const restored = reloaded.get(job.optimizationId)
    assert.ok(restored)
    assert.equal(restored.state, "generated")
    assert.equal(restored.candidateScriptHash, "cs")
    assert.deepEqual(reloaded.activeFingerprints(), [FP])
  })()
})
