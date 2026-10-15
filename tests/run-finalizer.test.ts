/**
 * RunFinalizer 单元测试（P1）
 *
 * 验证终态采集入口：
 *  - 正常完成采集：manifest completeness = full
 *  - 部分 agent 无 sessionId：completeness = partial
 *  - 全部采集失败：completeness = failed，manifest 仍写入
 *  - 回放 agent provenance：replayed=true 标记正确
 *  - adapter.collectSessionTrace 返回空：outputIntegrity = missing
 *  - History 文件落盘：history.jsonl 和 history.md 存在
 *  - 采集失败不阻断：finalizeRun 不抛错
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finalizeRun, type TraceCollectorPort, type FinalizerInput } from "../src/tools/run-finalizer.js"
import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../src/types/index.js"
import type { ToolCallEvent } from "../src/trace/collector.js"

/** 创建临时项目目录 */
function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "finalizer-test-"))
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

/** 构造测试用 AgentRecord */
function makeAgent(opts: {
  id: string
  label: string
  sessionId?: string
  replayed?: boolean
  workflowScopePath?: string[]
}): AgentRecord {
  return {
    id: opts.id,
    label: opts.label,
    status: "ok" as AgentRecord["status"],
    startedAt: 1000,
    durationMs: 1000,
    sessionId: opts.sessionId,
    replayed: opts.replayed,
    workflowScopePath: opts.workflowScopePath,
  }
}

/** 构造测试用 WorkflowExecutionRecord */
function makeWorkflow(scopePath: string[]): WorkflowExecutionRecord {
  return {
    name: "root",
    label: "root",
    keySegment: scopePath[scopePath.length - 1] ?? "root",
    displayPath: scopePath,
    scopePath,
    startedAt: 1000,
    endedAt: 3000,
    durationMs: 2000,
    status: "ok",
  }
}

/** 构造 ToolCallEvent */
function makeToolEvent(callID: string, tool: string): ToolCallEvent {
  return {
    callID,
    tool,
    messageID: "msg-1",
    partID: `prt-${callID}`,
    status: "completed",
    input: { filePath: `test-${callID}.ts` },
    output: "ok",
    startedAt: 1500,
    endedAt: 1600,
    partIndex: 0,
    messageIndex: 0,
  }
}

/** Fake adapter：返回预设的 ToolCallEvent */
function makeFakeAdapter(eventsMap: Map<string, ToolCallEvent[]>): TraceCollectorPort {
  return {
    async collectSessionTrace(sessionId: string): Promise<ToolCallEvent[]> {
      return eventsMap.get(sessionId) ?? []
    },
  }
}

/** 构造 FinalizerInput */
function makeInput(dir: string, overrides: Partial<FinalizerInput>): FinalizerInput {
  return {
    runId: "run-test",
    runAttemptId: "run-test:abc",
    rootRunId: "root-session",
    directory: dir,
    status: "completed",
    startedAt: 1000,
    agents: [],
    workflows: [],
    composites: [],
    adapter: makeFakeAdapter(new Map()),
    trigger: { type: "manual" },
    ...overrides,
  }
}

test("正常完成采集：manifest completeness = full，traces 有文件", async () => {
  await withTempDir(async (dir) => {
    const agentA = makeAgent({ id: "run-test:0", label: "reader", sessionId: "ses-a" })
    const agentB = makeAgent({ id: "run-test:1", label: "writer", sessionId: "ses-b" })
    const adapter = makeFakeAdapter(new Map([
      ["ses-a", [makeToolEvent("c1", "read")]],
      ["ses-b", [makeToolEvent("c2", "write")]],
    ]))

    const result = await finalizeRun(makeInput(dir, {
      agents: [agentA, agentB],
      workflows: [makeWorkflow(["root"])],
      adapter,
    }))

    assert.equal(result.completeness, "full")
    assert.equal(result.manifest.sessions.length, 2)
    assert.equal(result.manifest.sessions[0].sessionId, "ses-a")
    assert.equal(result.manifest.sessions[0].outputIntegrity, "full")
    assert.equal(result.manifest.sessions[1].sessionId, "ses-b")
    assert.equal(result.manifest.sessions[1].outputIntegrity, "full")

    // traces 文件存在
    const tracePath = join(dir, ".opencode-workflows", "history", "run-test", "attempts", "run-test-abc", "traces", "ses-a.jsonl")
    assert.ok(existsSync(tracePath))

    // history.jsonl 和 history.md 存在
    const jsonlPath = join(dir, ".opencode-workflows", "history", "run-test", "attempts", "run-test-abc", "history.jsonl")
    const mdPath = join(dir, ".opencode-workflows", "history", "run-test", "attempts", "run-test-abc", "history.md")
    assert.ok(existsSync(jsonlPath))
    assert.ok(existsSync(mdPath))
  })
})

test("部分 agent 无 sessionId：completeness = partial", async () => {
  await withTempDir(async (dir) => {
    const agentA = makeAgent({ id: "run-test:0", label: "good", sessionId: "ses-a" })
    const agentB = makeAgent({ id: "run-test:1", label: "bad" }) // 无 sessionId
    const adapter = makeFakeAdapter(new Map([
      ["ses-a", [makeToolEvent("c1", "read")]],
    ]))

    const result = await finalizeRun(makeInput(dir, {
      agents: [agentA, agentB],
      adapter,
    }))

    assert.equal(result.completeness, "partial")
    assert.equal(result.manifest.sessions[1].outputIntegrity, "unavailable")
    assert.ok(result.manifest.sessions[1].collectionError)
  })
})

test("全部采集失败：completeness = failed，manifest 仍写入", async () => {
  await withTempDir(async (dir) => {
    const agent = makeAgent({ id: "run-test:0", label: "empty", sessionId: "ses-a" })
    const adapter = makeFakeAdapter(new Map()) // 返回空数组

    const result = await finalizeRun(makeInput(dir, {
      agents: [agent],
      adapter,
    }))

    assert.equal(result.completeness, "failed")
    assert.equal(result.manifest.sessions[0].outputIntegrity, "missing")
    assert.equal(result.manifest.sessions[0].eventCount, 0)

    // manifest 仍写入
    const manifestPath = join(dir, ".opencode-workflows", "history", "run-test", "attempts", "run-test-abc", "manifest.json")
    assert.ok(existsSync(manifestPath))
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    assert.equal(manifest.completeness, "failed")
  })
})

test("回放 agent provenance：replayed=true 标记正确", async () => {
  await withTempDir(async (dir) => {
    // 先写入原始 Trace 文件（模拟上次执行已采集）
    const { TraceStore } = await import("../src/trace/store.js")
    const store = new TraceStore(dir)
    store.writeSessionTrace("run-prev", "ses-orig", [makeToolEvent("c1", "read")])

    const replayedAgent = makeAgent({
      id: "run-test:0",
      label: "replayed",
      sessionId: "ses-orig",
      replayed: true,
    })

    const result = await finalizeRun(makeInput(dir, {
      agents: [replayedAgent],
      resumeFromRunId: "run-prev",
    }))

    assert.equal(result.manifest.sessions.length, 1)
    assert.equal(result.manifest.sessions[0].replayed, true)
    assert.equal(result.manifest.sessions[0].sourceSessionId, "ses-orig")
    assert.equal(result.manifest.sessions[0].sourceRunAttemptId, "run-prev")
    // 原始 Trace 存在
    assert.equal(result.manifest.sessions[0].outputIntegrity, "full")
  })
})

test("回放 agent 原始 Trace 不存在：outputIntegrity = unavailable", async () => {
  await withTempDir(async (dir) => {
    const replayedAgent = makeAgent({
      id: "run-test:0",
      label: "replayed",
      sessionId: "ses-missing",
      replayed: true,
    })

    const result = await finalizeRun(makeInput(dir, {
      agents: [replayedAgent],
      resumeFromRunId: "run-old",
    }))

    assert.equal(result.manifest.sessions[0].replayed, true)
    assert.equal(result.manifest.sessions[0].outputIntegrity, "unavailable")
  })
})

test("回放 agent 无 sessionId：outputIntegrity = unavailable", async () => {
  await withTempDir(async (dir) => {
    const replayedAgent = makeAgent({
      id: "run-test:0",
      label: "replayed-no-ses",
      replayed: true,
    }) // 无 sessionId

    const result = await finalizeRun(makeInput(dir, {
      agents: [replayedAgent],
      resumeFromRunId: "run-old",
    }))

    assert.equal(result.manifest.sessions[0].replayed, true)
    assert.equal(result.manifest.sessions[0].outputIntegrity, "unavailable")
    assert.equal(result.manifest.sessions[0].sourceSessionId, undefined)
  })
})

test("混合回放与真实 agent：真实采集，回放标记 provenance", async () => {
  await withTempDir(async (dir) => {
    const { TraceStore } = await import("../src/trace/store.js")
    const store = new TraceStore(dir)
    store.writeSessionTrace("run-prev", "ses-orig", [makeToolEvent("c0", "read")])

    const realAgent = makeAgent({ id: "run-test:0", label: "real", sessionId: "ses-new" })
    const replayedAgent = makeAgent({ id: "run-test:1", label: "replayed", sessionId: "ses-orig", replayed: true })
    const adapter = makeFakeAdapter(new Map([
      ["ses-new", [makeToolEvent("c1", "write")]],
    ]))

    const result = await finalizeRun(makeInput(dir, {
      agents: [realAgent, replayedAgent],
      workflows: [makeWorkflow(["root"])],
      adapter,
      resumeFromRunId: "run-prev",
    }))

    assert.equal(result.completeness, "full") // 只有 1 个真实 agent，采集成功
    assert.equal(result.manifest.sessions.length, 2)

    const realEntry = result.manifest.sessions.find((s) => s.agentId === "run-test:0")
    assert.equal(realEntry.replayed, false)
    assert.equal(realEntry.outputIntegrity, "full")

    const replayedEntry = result.manifest.sessions.find((s) => s.agentId === "run-test:1")
    assert.equal(replayedEntry.replayed, true)
    assert.equal(replayedEntry.outputIntegrity, "full")
    assert.equal(replayedEntry.sourceRunAttemptId, "run-prev")
  })
})

test("status 传递：failed 状态写入 manifest", async () => {
  await withTempDir(async (dir) => {
    const result = await finalizeRun(makeInput(dir, {
      status: "failed",
      agents: [],
    }))

    assert.equal(result.manifest.status, "failed")
  })
})

test("status 传递：aborted 状态写入 manifest", async () => {
  await withTempDir(async (dir) => {
    const result = await finalizeRun(makeInput(dir, {
      status: "aborted",
      agents: [],
    }))

    assert.equal(result.manifest.status, "aborted")
  })
})

test("空 agents 列表：completeness = failed，不报错", async () => {
  await withTempDir(async (dir) => {
    const result = await finalizeRun(makeInput(dir, {
      agents: [],
    }))

    assert.equal(result.completeness, "failed")
    assert.equal(result.manifest.sessions.length, 0)
  })
})

test("history.jsonl 含工具调用事件", async () => {
  await withTempDir(async (dir) => {
    const agent = makeAgent({ id: "run-test:0", label: "worker", sessionId: "ses-a" })
    const adapter = makeFakeAdapter(new Map([
      ["ses-a", [makeToolEvent("c1", "read"), makeToolEvent("c2", "write")]],
    ]))

    await finalizeRun(makeInput(dir, {
      agents: [agent],
      workflows: [makeWorkflow(["root"])],
      adapter,
    }))

    const jsonlPath = join(dir, ".opencode-workflows", "history", "run-test", "attempts", "run-test-abc", "history.jsonl")
    const jsonl = readFileSync(jsonlPath, "utf8")
    const events = jsonl.split("\n").map((l) => JSON.parse(l))
    const toolCalls = events.filter((e: { type: string }) => e.type === "tool_call")
    assert.equal(toolCalls.length, 2)
  })
})
