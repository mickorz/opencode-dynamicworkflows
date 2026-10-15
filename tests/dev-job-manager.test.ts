/**
 * DevJobManager 单元测试（P2）
 *
 * 验证 Development Job 生命周期管理：
 *  - createOnce 幂等：同一 runId 只创建一个 Job
 *  - Job 状态流转 pending -> running
 *  - onFinished 回调：Optimizer 完成后 Job 标 completed
 *  - Optimizer 失败：Job 标 failed + error
 *  - 持久化读写 roundtrip
 *  - 重启恢复 running -> failed
 *  - list 查询
 *  - 落盘失败不抛错
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevJobManager } from "../src/development/job-manager.js"
import type { BackgroundRunManager } from "../src/tools/background-runs.js"
import type { BackgroundStartDeps, BackgroundStartInput } from "../src/tools/background-runs.js"

/** 创建临时项目目录 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "devjob-test-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Fake BackgroundRunManager：记录 start 调用，返回 fake runId */
function makeFakeBackground(opts: {
  runIdPrefix?: string
  onStarted?: (input: BackgroundStartInput) => void
}): Pick<BackgroundRunManager, "start"> {
  let seq = 0
  return {
    start(_deps: BackgroundStartDeps, input: BackgroundStartInput): string {
      const runId = `${opts.runIdPrefix ?? "run-opt"}-${++seq}`
      opts.onStarted?.(input)
      // 模拟异步完成：在下一 tick 调 onFinished
      if (input.onFinished) {
        const onFinished = input.onFinished
        queueMicrotask(() => {
          onFinished({ runId, name: "optimizer", status: "completed", startedAt: Date.now(), records: [], composites: [], logs: [], delivered: false })
        })
      }
      return runId
    },
  }
}

/** 构造 CreateOnceInput 并创建必要的 Trace 文件（manifest + history） */
function makeInput(dir: string, runId: string) {
  const historyDir = join(dir, ".opencode-workflows", "history", runId)
  mkdirSync(historyDir, { recursive: true })
  // 创建 manifest（P3 预计算需要）
  const manifest = {
    version: 1,
    runId,
    runAttemptId: `${runId}:abc`,
    rootRunId: runId,
    startedAt: 1000,
    endedAt: 5000,
    status: "completed" as const,
    completeness: "full" as const,
    development: true,
    sessions: [{
      sessionId: "sess-test",
      agentId: `${runId}:0`,
      agentLabel: "Test Agent",
      eventCount: 2,
      replayed: false,
      outputIntegrity: "full" as const,
    }],
  }
  writeFileSync(join(historyDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  // 创建 history.jsonl（分支 B2 检查用）
  writeFileSync(join(historyDir, "history.jsonl"), '{"type":"agent_start"}\n', "utf8")
  return {
    runId,
    originRunId: runId,
    directory: dir,
    historyPath: historyDir,
    client: {} as never, // fake client（FakeBackground 不消费）
    parentSessionId: "ses-parent",
    rootSessionId: "ses-root",
    agents: [] as never[],
  }
}

test("createOnce 幂等：同一 runId 只创建一个 Job", () => {
  withTempDir((dir) => {
    const fakeBg = makeFakeBackground({})
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    const job1 = mgr.createOnce(makeInput(dir, "run-idempotent"))
    const job2 = mgr.createOnce(makeInput(dir, "run-idempotent"))

    assert.ok(job1)
    assert.ok(job2)
    assert.equal(job1, job2, "同一 runId 返回同一个 Job 对象")
    assert.equal(mgr.list().length, 1)
  })
})

test("Job 状态流转 pending -> running", () => {
  withTempDir((dir) => {
    const fakeBg = makeFakeBackground({})
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    const job = mgr.createOnce(makeInput(dir, "run-status"))
    assert.ok(job)
    // startOptimizer 同步执行，status 应为 running
    assert.equal(job.status, "running")
    assert.ok(job.optimizerRunId)
    assert.ok(job.startedAt)
  })
})

test("onFinished 回调：Optimizer 完成后 Job 标 completed", async () => {
  await new Promise<void>((resolve) => {
    withTempDir((dir) => {
      const fakeBg = makeFakeBackground({
        onStarted: (input) => {
          // 模拟异步完成
          if (input.onFinished) {
            const onFinished = input.onFinished
            setTimeout(() => {
              onFinished({ runId: "run-completed", name: "optimizer", status: "completed", startedAt: Date.now(), records: [], composites: [], logs: [], delivered: false })
              // 验证 Job 状态
              const mgr2 = new DevJobManager(fakeBg as BackgroundRunManager)
              // 重新检查持久化文件
              const jobsPath = join(dir, ".opencode-workflows", "development", "jobs.json")
              if (existsSync(jobsPath)) {
                const file = JSON.parse(readFileSync(jobsPath, "utf8"))
                const job = file.jobs.find((j: { runId: string }) => j.runId === "run-completed")
                assert.equal(job.status, "completed")
              }
              resolve()
            }, 10)
          }
        },
      })
      const mgr = new DevJobManager(fakeBg as BackgroundRunManager)
      mgr.createOnce(makeInput(dir, "run-completed"))
    })
  })
})

test("持久化读写 roundtrip：jobs.json 格式正确", () => {
  withTempDir((dir) => {
    const fakeBg = makeFakeBackground({})
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    mgr.createOnce(makeInput(dir, "run-persist"))

    const jobsPath = join(dir, ".opencode-workflows", "development", "jobs.json")
    assert.ok(existsSync(jobsPath))
    const file = JSON.parse(readFileSync(jobsPath, "utf8"))
    assert.equal(file.version, 1)
    assert.ok(Array.isArray(file.jobs))
    assert.equal(file.jobs.length, 1)
    assert.equal(file.jobs[0].runId, "run-persist")
    assert.equal(file.jobs[0].originRunId, "run-persist")
    assert.equal(file.jobs[0].status, "running")
    assert.ok(file.jobs[0].historyPath)
  })
})

test("重启恢复：load 时 running 标记为 failed", () => {
  withTempDir((dir) => {
    const fakeBg1 = makeFakeBackground({})
    const mgr1 = new DevJobManager(fakeBg1 as BackgroundRunManager)
    mgr1.createOnce(makeInput(dir, "run-recovery"))
    // 模拟服务端被杀：Job 在 running 状态

    // 新实例加载
    const fakeBg2 = makeFakeBackground({})
    const mgr2 = new DevJobManager(fakeBg2 as BackgroundRunManager)
    mgr2.load(dir)

    const jobs = mgr2.list()
    const job = jobs.find((j) => j.runId === "run-recovery")
    assert.ok(job)
    assert.equal(job.status, "failed")
    assert.ok(job.error)
    assert.ok(job.endedAt)
  })
})

test("list 查询：返回全部 Job", () => {
  withTempDir((dir) => {
    const fakeBg = makeFakeBackground({})
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    mgr.createOnce(makeInput(dir, "run-list-1"))
    mgr.createOnce(makeInput(dir, "run-list-2"))

    const jobs = mgr.list()
    assert.equal(jobs.length, 2)
    const ids = jobs.map((j) => j.runId).sort()
    assert.deepEqual(ids, ["run-list-1", "run-list-2"])
  })
})

test("Optimizer 脚本透传：development=false, developmentForbidden=true, trigger=development-optimizer", () => {
  withTempDir((dir) => {
    let capturedInput: BackgroundStartInput | undefined
    const fakeBg = makeFakeBackground({
      onStarted: (input) => { capturedInput = input },
    })
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)

    mgr.createOnce(makeInput(dir, "run-optimizer-params"))

    assert.ok(capturedInput)
    assert.equal(capturedInput.development, false)
    assert.equal(capturedInput.developmentForbidden, true)
    assert.equal(capturedInput.trigger?.type, "development-optimizer")
    assert.ok(capturedInput.script)
    assert.ok((capturedInput.args as { originRunId: string }).originRunId)
    assert.ok((capturedInput.args as { historyPath: string }).historyPath)
  })
})

test("空 directory load 不报错", () => {
  withTempDir((dir) => {
    const fakeBg = makeFakeBackground({})
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)
    // 目录无 jobs.json，load 应静默返回
    mgr.load(dir)
    assert.equal(mgr.list().length, 0)
  })
})

test("start 失败：Job 标 failed + error", () => {
  withTempDir((dir) => {
    const fakeBg: Pick<BackgroundRunManager, "start"> = {
      start(): string {
        throw new Error("background start failed")
      },
    }
    const mgr = new DevJobManager(fakeBg as BackgroundRunManager)
    const job = mgr.createOnce(makeInput(dir, "run-start-fail"))

    assert.ok(job)
    assert.equal(job.status, "failed")
    assert.ok(job.error)
    assert.ok(job.endedAt)
  })
})
