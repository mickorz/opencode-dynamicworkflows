/**
 * HistoryBuilder 单元测试（P1）
 *
 * 验证合并执行树与全局时间线：
 *  - 单 Workflow 单 Agent 单工具：事件序列正确
 *  - 父子 Workflow：scopePath 层级正确，事件按时间排序
 *  - 并行 Agent：时间线允许多 Agent 事件交叠
 *  - 回放 Agent：replayed=true 的 agent 无 tool_call 事件，但 agent_start/end 仍记录
 *  - 空输入：不报错，产出空 jsonl 和最小 md
 *  - Markdown 格式：标题、执行树、工具序列、回放来源各段齐全
 *  - 多工具调用按时间排序
 */

import test from "node:test"
import assert from "node:assert/strict"
import { buildHistory } from "../src/history/builder.js"
import type { HistoryBuildInput } from "../src/history/builder.js"
import type { AgentRecord, WorkflowExecutionRecord, CompositeRecord } from "../src/types/index.js"
import type { ToolCallEvent } from "../src/trace/collector.js"
import type { SessionManifestEntry } from "../src/trace/types.js"

/** 构造最小 AgentRecord */
function makeAgent(opts: {
  id: string
  label: string
  startedAt: number
  durationMs: number
  status?: string
  sessionId?: string
  replayed?: boolean
  workflowScopePath?: string[]
}): AgentRecord {
  return {
    id: opts.id,
    label: opts.label,
    status: (opts.status ?? "ok") as AgentRecord["status"],
    startedAt: opts.startedAt,
    durationMs: opts.durationMs,
    sessionId: opts.sessionId,
    replayed: opts.replayed,
    workflowScopePath: opts.workflowScopePath,
  }
}

/** 构造最小 WorkflowExecutionRecord */
function makeWorkflow(opts: {
  name: string
  label: string
  scopePath: string[]
  startedAt: number
  endedAt?: number
  durationMs?: number
  status?: string
}): WorkflowExecutionRecord {
  return {
    name: opts.name,
    label: opts.label,
    keySegment: opts.scopePath[opts.scopePath.length - 1] ?? "root",
    displayPath: opts.scopePath,
    scopePath: opts.scopePath,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    durationMs: opts.durationMs,
    status: (opts.status ?? "ok") as WorkflowExecutionRecord["status"],
  }
}

/** 构造 ToolCallEvent */
function makeToolEvent(callID: string, tool: string, ts: number): ToolCallEvent {
  return {
    callID,
    tool,
    messageID: "msg-1",
    partID: `prt-${callID}`,
    status: "completed",
    input: { filePath: `test-${callID}.ts` },
    output: "ok",
    startedAt: ts,
    endedAt: ts + 100,
    partIndex: 0,
    messageIndex: 0,
  }
}

/** 构造 HistoryBuildInput */
function makeInput(opts: {
  agents: AgentRecord[]
  workflows: WorkflowExecutionRecord[]
  sessionEvents: Array<{ sessionId: string; agentId: string; events: ToolCallEvent[] }>
  sessionEntries?: SessionManifestEntry[]
  startedAt?: number
  endedAt?: number
}): HistoryBuildInput {
  return {
    runId: "run-test",
    runAttemptId: "run-test:abc",
    agents: opts.agents,
    workflows: opts.workflows,
    composites: [] as CompositeRecord[],
    sessionEvents: opts.sessionEvents,
    sessionEntries: opts.sessionEntries ?? [],
    startedAt: opts.startedAt ?? 1000,
    endedAt: opts.endedAt ?? 5000,
    status: "completed",
  }
}

test("单 Workflow 单 Agent 单工具：事件序列 workflow_start agent_start tool_call agent_end workflow_end", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 4000, durationMs: 3000 })
  const agent = makeAgent({ id: "run-test:0", label: "reader", startedAt: 1500, durationMs: 1000, sessionId: "ses-a", workflowScopePath: ["root"] })
  const toolEvent = makeToolEvent("call-1", "read", 1600)

  const result = buildHistory(makeInput({
    agents: [agent],
    workflows: [wf],
    sessionEvents: [{ sessionId: "ses-a", agentId: "run-test:0", events: [toolEvent] }],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  assert.equal(events.length, 5)
  assert.equal(events[0].type, "workflow_start")
  assert.equal(events[0].ts, 1000)
  assert.equal(events[1].type, "agent_start")
  assert.equal(events[1].ts, 1500)
  assert.equal(events[2].type, "tool_call")
  assert.equal(events[2].tool, "read")
  assert.equal(events[3].type, "agent_end")
  assert.equal(events[3].ts, 2500)
  assert.equal(events[4].type, "workflow_end")
  assert.equal(events[4].ts, 4000)
})

test("父子 Workflow：scopePath 层级正确，事件按时间排序", () => {
  const rootWf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 5000, durationMs: 4000 })
  const childWf = makeWorkflow({ name: "child", label: "child", scopePath: ["root", "wf0"], startedAt: 1500, endedAt: 3000, durationMs: 1500 })

  const agent = makeAgent({ id: "run-test:0", label: "worker", startedAt: 2000, durationMs: 500, sessionId: "ses-a", workflowScopePath: ["root", "wf0"] })
  const toolEvent = makeToolEvent("call-1", "write", 2100)

  const result = buildHistory(makeInput({
    agents: [agent],
    workflows: [rootWf, childWf],
    sessionEvents: [{ sessionId: "ses-a", agentId: "run-test:0", events: [toolEvent] }],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  // 按时间排序：1000(wf_start root) 1500(wf_start child) 2000(agent_start) 2100(tool) 2500(agent_end) 3000(wf_end child) 5000(wf_end root)
  assert.equal(events[0].type, "workflow_start")
  assert.deepEqual(events[0].scopePath, ["root"])
  assert.equal(events[1].type, "workflow_start")
  assert.deepEqual(events[1].scopePath, ["root", "wf0"])
  assert.equal(events[2].type, "agent_start")
  assert.deepEqual(events[2].scopePath, ["root", "wf0"])
  assert.equal(events[3].type, "tool_call")
  assert.equal(events[4].type, "agent_end")
  assert.equal(events[5].type, "workflow_end")
  assert.deepEqual(events[5].scopePath, ["root", "wf0"])
  assert.equal(events[6].type, "workflow_end")
  assert.deepEqual(events[6].scopePath, ["root"])
})

test("并行 Agent：时间线允许多 Agent 事件交叠", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 5000, durationMs: 4000 })
  const agentA = makeAgent({ id: "run-test:0", label: "agentA", startedAt: 1500, durationMs: 2000, sessionId: "ses-a", workflowScopePath: ["root"] })
  const agentB = makeAgent({ id: "run-test:1", label: "agentB", startedAt: 1600, durationMs: 1000, sessionId: "ses-b", workflowScopePath: ["root"] })
  const toolA = makeToolEvent("call-a", "read", 1700)
  const toolB = makeToolEvent("call-b", "write", 1800)

  const result = buildHistory(makeInput({
    agents: [agentA, agentB],
    workflows: [wf],
    sessionEvents: [
      { sessionId: "ses-a", agentId: "run-test:0", events: [toolA] },
      { sessionId: "ses-b", agentId: "run-test:1", events: [toolB] },
    ],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  // 检查事件按时间排序
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].ts >= events[i - 1].ts, `Event ${i} ts ${events[i].ts} < prev ${events[i - 1].ts}`)
  }
  // 检查两个 agent 的 tool_call 都在
  const toolCalls = events.filter((e: { type: string }) => e.type === "tool_call")
  assert.equal(toolCalls.length, 2)
  assert.equal(toolCalls[0].tool, "read")
  assert.equal(toolCalls[1].tool, "write")
})

test("回放 Agent：replayed=true 的 agent 有 agent_start/end 但无 tool_call", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 3000, durationMs: 2000 })
  const replayedAgent = makeAgent({
    id: "run-test:0",
    label: "replayed",
    startedAt: 1500,
    durationMs: 0,
    replayed: true,
    workflowScopePath: ["root"],
  })

  const result = buildHistory(makeInput({
    agents: [replayedAgent],
    workflows: [wf],
    sessionEvents: [], // 回放 agent 无 session events
    sessionEntries: [{
      sessionId: "ses-original",
      agentLabel: "replayed",
      agentId: "run-test:0",
      eventCount: 0,
      replayed: true,
      sourceRunAttemptId: "run-test:prev",
      sourceSessionId: "ses-original",
      outputIntegrity: "full",
    }],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  // 应有 workflow_start, agent_start(replayed), agent_end(replayed), workflow_end
  assert.equal(events.length, 4)
  assert.equal(events[1].type, "agent_start")
  assert.equal(events[1].replayed, true)
  assert.equal(events[2].type, "agent_end")
  assert.equal(events[2].replayed, true)
  // 无 tool_call 事件
  const toolCalls = events.filter((e: { type: string }) => e.type === "tool_call")
  assert.equal(toolCalls.length, 0)

  // Markdown 应含 Replayed Agents 段
  assert.ok(result.md.includes("## Replayed Agents"))
  assert.ok(result.md.includes("replayed <- run-test:prev"))
})

test("空输入：不报错，产出空 jsonl 和最小 md", () => {
  const result = buildHistory(makeInput({
    agents: [],
    workflows: [],
    sessionEvents: [],
  }))

  assert.equal(result.jsonl, "")
  assert.equal(result.md, "")
})

test("Markdown 格式：标题、执行树、工具序列各段齐全", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 4000, durationMs: 3000 })
  const agent = makeAgent({ id: "run-test:0", label: "worker", startedAt: 1500, durationMs: 1000, sessionId: "ses-a", workflowScopePath: ["root"] })
  const toolEvent = makeToolEvent("call-1", "bash", 1600)

  const result = buildHistory(makeInput({
    agents: [agent],
    workflows: [wf],
    sessionEvents: [{ sessionId: "ses-a", agentId: "run-test:0", events: [toolEvent] }],
  }))

  assert.ok(result.md.includes("# Workflow History: run-test"))
  assert.ok(result.md.includes("## Execution Tree"))
  assert.ok(result.md.includes("[ok] root"))
  assert.ok(result.md.includes("## Tool Call Sequence"))
  assert.ok(result.md.includes("worker | bash"))
})

test("多工具调用按时间排序：同一 agent 多个工具调用", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 6000, durationMs: 5000 })
  const agent = makeAgent({ id: "run-test:0", label: "multi", startedAt: 1500, durationMs: 3000, sessionId: "ses-a", workflowScopePath: ["root"] })
  const tool1 = makeToolEvent("call-1", "read", 3000)
  const tool2 = makeToolEvent("call-2", "write", 2000)
  const tool3 = makeToolEvent("call-3", "bash", 4000)

  const result = buildHistory(makeInput({
    agents: [agent],
    workflows: [wf],
    sessionEvents: [{ sessionId: "ses-a", agentId: "run-test:0", events: [tool1, tool2, tool3] }],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  const toolCalls = events.filter((e: { type: string }) => e.type === "tool_call")
  // 按 ts 排序：2000(read? no, write), 3000(read), 4000(bash)
  assert.equal(toolCalls[0].ts, 2000)
  assert.equal(toolCalls[0].tool, "write")
  assert.equal(toolCalls[1].ts, 3000)
  assert.equal(toolCalls[1].tool, "read")
  assert.equal(toolCalls[2].ts, 4000)
  assert.equal(toolCalls[2].tool, "bash")
})

test("混合回放与真实 agent：真实 agent 有 tool_call，回放 agent 无", () => {
  const wf = makeWorkflow({ name: "root", label: "root", scopePath: ["root"], startedAt: 1000, endedAt: 5000, durationMs: 4000 })
  const realAgent = makeAgent({ id: "run-test:0", label: "real", startedAt: 1500, durationMs: 2000, sessionId: "ses-a", workflowScopePath: ["root"] })
  const replayedAgent = makeAgent({ id: "run-test:1", label: "replayed", startedAt: 1600, durationMs: 0, replayed: true, workflowScopePath: ["root"] })
  const tool = makeToolEvent("call-1", "edit", 1700)

  const result = buildHistory(makeInput({
    agents: [realAgent, replayedAgent],
    workflows: [wf],
    sessionEvents: [{ sessionId: "ses-a", agentId: "run-test:0", events: [tool] }],
    sessionEntries: [{
      sessionId: "ses-orig",
      agentLabel: "replayed",
      agentId: "run-test:1",
      eventCount: 0,
      replayed: true,
      sourceRunAttemptId: "run-test:prev",
      sourceSessionId: "ses-orig",
      outputIntegrity: "unavailable",
    }],
  }))

  const events = result.jsonl.split("\n").map((l) => JSON.parse(l))
  const toolCalls = events.filter((e: { type: string }) => e.type === "tool_call")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].agentId, "run-test:0")

  // 回放 agent 的 agent_start 和 agent_end 应标记 replayed
  const agentStarts = events.filter((e: { type: string }) => e.type === "agent_start")
  assert.equal(agentStarts.length, 2)
  const replayedStart = agentStarts.find((e: { agentId: string }) => e.agentId === "run-test:1")
  assert.equal(replayedStart.replayed, true)
  const realStart = agentStarts.find((e: { agentId: string }) => e.agentId === "run-test:0")
  assert.notEqual(realStart.replayed, true)
})
