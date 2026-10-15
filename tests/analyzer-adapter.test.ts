/**
 * P3-A 适配层单元测试
 *
 * 验证 AnalysisToolEvent 适配层：
 *  - callID 去重：pending/running/completed 只保留最终态
 *  - AgentRecord 关联：按 sessionId 匹配，缺失时回退到 manifest
 *  - 事件按 startedAt 排序
 *  - 空输入不报错
 */

import test from "node:test"
import assert from "node:assert/strict"
import { buildAnalysisEvents } from "../src/development/analyzer/adapter.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import type { TraceManifest, SessionManifestEntry } from "../src/trace/types.js"
import type { AgentRecord } from "../src/types/index.js"
import { TraceStore } from "../src/trace/store.js"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/** 构造临时 TraceStore 并写入测试数据 */
function makeTestStore(opts: {
  sessions: Array<{ sessionId: string; events: ReturnType<typeof FIXTURES.empty> }>
  manifest: TraceManifest
}): { store: TraceStore; cleanup: () => void } {
  const tmpBase = join(tmpdir(), `p3-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpBase, { recursive: true })

  const store = new TraceStore(tmpBase)
  store.writeManifest(opts.manifest.runId, opts.manifest)

  for (const { sessionId, events } of opts.sessions) {
    store.writeSessionTrace(opts.manifest.runId, sessionId, events)
  }

  return {
    store,
    cleanup: () => {
      try { rmSync(tmpBase, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

/** 构造最小 manifest */
function makeManifest(opts: {
  runId?: string
  runAttemptId?: string
  sessions: SessionManifestEntry[]
}): TraceManifest {
  return {
    version: 1,
    runId: opts.runId ?? "run-test",
    runAttemptId: opts.runAttemptId ?? "run-test:abc",
    rootRunId: "run-test",
    startedAt: 1000,
    endedAt: 5000,
    status: "completed",
    completeness: "full",
    development: true,
    sessions: opts.sessions,
  }
}

/** 构造最小 SessionManifestEntry */
function makeSessionEntry(opts: {
  sessionId: string
  agentId?: string
  agentLabel?: string
  eventCount?: number
  replayed?: boolean
}): SessionManifestEntry {
  return {
    sessionId: opts.sessionId,
    agentId: opts.agentId ?? "run-test:0",
    agentLabel: opts.agentLabel ?? "Agent A",
    eventCount: opts.eventCount ?? 0,
    replayed: opts.replayed ?? false,
    outputIntegrity: "full",
  }
}

/** 构造最小 AgentRecord */
function makeAgent(opts: {
  id: string
  label: string
  sessionId?: string
  startedAt?: number
  durationMs?: number
  workflowScopePath?: string[]
  replayed?: boolean
}): AgentRecord {
  return {
    id: opts.id,
    label: opts.label,
    status: "ok",
    startedAt: opts.startedAt,
    durationMs: opts.durationMs,
    sessionId: opts.sessionId,
    workflowScopePath: opts.workflowScopePath,
    replayed: opts.replayed,
  }
}

test("callID 去重：pending/running/completed 只保留最终态", () => {
  const events = FIXTURES.callIDStates()
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }),
    sessions: [{ sessionId: "sess-1", events }],
  })

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }), [])

    // 3 条原始事件（pending + running + completed）去重为 1 条
    assert.equal(result.length, 1, "应只剩 1 条最终态事件")
    assert.equal(result[0].status, "completed", "最终态应为 completed")
    assert.equal(result[0].callID, "c1")
  } finally {
    cleanup()
  }
})

test("AgentRecord 按 sessionId 关联：注入 agentId/agentLabel/workflowScopePath", () => {
  const events = FIXTURES.scriptExtraction()
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }),
    sessions: [{ sessionId: "sess-1", events }],
  })

  const agents = [
    makeAgent({
      id: "run-test:0",
      label: "脚本写入 Agent",
      sessionId: "sess-1",
      startedAt: 900,
      durationMs: 2000,
      workflowScopePath: ["root", "wf0"],
    }),
  ]

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }), agents)

    assert.equal(result.length, 2, "应返回 2 条事件（write + bash）")
    // 验证 Agent 元数据注入
    for (const event of result) {
      assert.equal(event.agentId, "run-test:0")
      assert.equal(event.agentLabel, "脚本写入 Agent")
      assert.deepEqual(event.workflowScopePath, ["root", "wf0"])
      assert.equal(event.replayed, false)
    }
  } finally {
    cleanup()
  }
})

test("AgentRecord 缺失时回退到 manifest 数据", () => {
  const events = FIXTURES.repeatSameRead()
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [makeSessionEntry({
        sessionId: "sess-1",
        agentId: "manifest-agent-id",
        agentLabel: "Manifest Agent",
        eventCount: events.length,
      })],
    }),
    sessions: [{ sessionId: "sess-1", events }],
  })

  try {
    // 不传 agents，应回退到 manifest 数据
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [makeSessionEntry({
        sessionId: "sess-1",
        agentId: "manifest-agent-id",
        agentLabel: "Manifest Agent",
        eventCount: events.length,
      })],
    }), [])

    assert.equal(result.length, 2)
    assert.equal(result[0].agentId, "manifest-agent-id")
    assert.equal(result[0].agentLabel, "Manifest Agent")
  } finally {
    cleanup()
  }
})

test("事件按 startedAt 排序", () => {
  // 故意倒序写入
  const events = [
    FIXTURES.scriptExtraction()[1], // startedAt: 2000
    FIXTURES.scriptExtraction()[0], // startedAt: 1000
  ]
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }),
    sessions: [{ sessionId: "sess-1", events }],
  })

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", eventCount: events.length })],
    }), [])

    assert.equal(result.length, 2)
    assert.ok((result[0].startedAt ?? 0) <= (result[1].startedAt ?? 0), "应按 startedAt 升序")
    assert.equal(result[0].tool, "write", "第一个应为 write")
    assert.equal(result[1].tool, "bash", "第二个应为 bash")
  } finally {
    cleanup()
  }
})

test("多 session 事件合并", () => {
  const eventsA = FIXTURES.repeatSameRead()
  const eventsB = FIXTURES.scriptExtraction()
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [
        makeSessionEntry({ sessionId: "sess-a", eventCount: eventsA.length }),
        makeSessionEntry({ sessionId: "sess-b", agentLabel: "Agent B", eventCount: eventsB.length }),
      ],
    }),
    sessions: [
      { sessionId: "sess-a", events: eventsA },
      { sessionId: "sess-b", events: eventsB },
    ],
  })

  const agents = [
    makeAgent({ id: "run-test:0", label: "Agent A", sessionId: "sess-a" }),
    makeAgent({ id: "run-test:1", label: "Agent B", sessionId: "sess-b" }),
  ]

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [
        makeSessionEntry({ sessionId: "sess-a", eventCount: eventsA.length }),
        makeSessionEntry({ sessionId: "sess-b", agentLabel: "Agent B", eventCount: eventsB.length }),
      ],
    }), agents)

    assert.equal(result.length, 4, "两个 session 合并后共 4 条事件")
    // 验证不同 session 的 agentLabel 正确注入
    const labels = new Set(result.map((e) => e.agentLabel))
    assert.ok(labels.has("Agent A"))
    assert.ok(labels.has("Agent B"))
  } finally {
    cleanup()
  }
})

test("空 manifest sessions 不报错", () => {
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({ sessions: [] }),
    sessions: [],
  })

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({ sessions: [] }), [])
    assert.equal(result.length, 0)
  } finally {
    cleanup()
  }
})

test("回放 agent 标记 replayed=true", () => {
  const events = FIXTURES.repeatSameRead()
  const { store, cleanup } = makeTestStore({
    manifest: makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", replayed: true, eventCount: events.length })],
    }),
    sessions: [{ sessionId: "sess-1", events }],
  })

  try {
    const result = buildAnalysisEvents(store, "run-test", makeManifest({
      sessions: [makeSessionEntry({ sessionId: "sess-1", replayed: true, eventCount: events.length })],
    }), [])

    for (const event of result) {
      assert.equal(event.replayed, true, "回放 agent 的事件应标记 replayed=true")
    }
  } finally {
    cleanup()
  }
})
