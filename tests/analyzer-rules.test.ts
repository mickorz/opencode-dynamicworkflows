/**
 * P3-B 四类规则单元测试
 *
 * 验证修正后的规则：
 *  - Repeat：递归 stableStringify + 不直接生成 Proposal
 *  - Retry：时间窗口 + confirmed/possible 分级
 *  - Dependency：write→read 同文件关联
 *  - Latency：per-Agent gap + 不跨 Agent + 不直接生成 Proposal
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  detectRepeats,
  detectRetries,
  detectDependencies,
  analyzeLatency,
  stableStringify,
  signature,
} from "../src/development/analyzer/rules.js"
import { FIXTURES } from "./analyzer-fixtures.js"
import type { AnalysisToolEvent } from "../src/development/analyzer/types.js"
import type { AgentRecord } from "../src/types/index.js"

// ============================================================
// stableStringify 单元测试
// ============================================================

test("stableStringify：递归排序嵌套对象键", () => {
  const a = { b: 1, a: 2, c: { z: 3, y: 4 } }
  const result = stableStringify(a)
  assert.equal(result, '{"a":2,"b":1,"c":{"y":4,"z":3}}')
})

test("stableStringify：嵌套对象不同值不误判为相同", () => {
  // v2 bug 测试：这两个对象的嵌套属性不同，不应序列化为相同结果
  const a = { options: { command: "npm test" } }
  const b = { options: { command: "npm run build" } }
  assert.notEqual(stableStringify(a), stableStringify(b), "嵌套属性不同不应序列化为相同结果")
})

test("stableStringify：键顺序不同但内容相同应序列化为相同", () => {
  const a = { b: 1, a: 2 }
  const b = { a: 2, b: 1 }
  assert.equal(stableStringify(a), stableStringify(b))
})

test("stableStringify：数组保持顺序", () => {
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]')
})

test("stableStringify：null 和原始类型", () => {
  assert.equal(stableStringify(null), "null")
  assert.equal(stableStringify(42), "42")
  assert.equal(stableStringify("hello"), '"hello"')
  assert.equal(stableStringify(true), "true")
})

// ============================================================
// Rule 1: Repeat 检测
// ============================================================

test("repeat：同 tool 同 input 触发重复", () => {
  const events = FIXTURES.repeatSameRead()
  const repeats = detectRepeats(events)
  assert.equal(repeats.length, 1, "应检测到 1 组重复")
  assert.equal(repeats[0].count, 2)
  assert.equal(repeats[0].tool, "read")
  assert.equal(repeats[0].occurrences.length, 2)
})

test("repeat：不同 input 不算重复", () => {
  const events: AnalysisToolEvent[] = [
    ...FIXTURES.repeatSameRead(),
    // 添加一个不同 input 的 read
    {
      ...FIXTURES.repeatSameRead()[0],
      callID: "c3",
      input: { filePath: "other.json" },
      startedAt: 3000,
      endedAt: 3100,
    },
  ]
  const repeats = detectRepeats(events)
  // 原来的两次相同 read 仍重复，新的不重复
  assert.equal(repeats.length, 1, "只有原来 2 次相同 read 算重复")
  assert.equal(repeats[0].count, 2)
})

test("repeat：write 同脚本触发重复", () => {
  const events = FIXTURES.repeatSameWrite()
  const repeats = detectRepeats(events)
  assert.equal(repeats.length, 1)
  assert.equal(repeats[0].count, 2)
  assert.equal(repeats[0].tool, "write")
})

test("repeat：detectRepeats 返回 Observation 不是 Proposal", () => {
  // detectRepeats 返回 RepeatObservation[]，不含 Proposal 字段
  const events = FIXTURES.repeatSameRead()
  const repeats = detectRepeats(events)
  assert.equal(repeats.length, 1)
  // RepeatObservation 没有 category/evidenceIntegrity/candidateConfidence 等 Proposal 字段
  const obs = repeats[0]
  assert.ok("tool" in obs)
  assert.ok("inputSignature" in obs)
  assert.ok("count" in obs)
  assert.ok("occurrences" in obs)
  assert.ok(!("category" in obs), "Observation 不应有 category 字段")
  assert.ok(!("candidateConfidence" in obs), "Observation 不应有 candidateConfidence 字段")
})

test("repeat：嵌套 input 不同值不误判为重复", () => {
  // v2 bug 场景：嵌套属性不同的 input 不应被误判为签名相同
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "c1",
      input: { filePath: "a.py", options: { command: "npm test" } },
    },
    {
      ...FIXTURES.scriptExtraction()[0],
      callID: "c2",
      input: { filePath: "a.py", options: { command: "npm run build" } },
    },
  ]
  const repeats = detectRepeats(events)
  assert.equal(repeats.length, 0, "嵌套属性不同的 input 不应被误判为重复")
})

// ============================================================
// Rule 2: Retry 检测
// ============================================================

test("retry：confirmed（同 tool 同 input）", () => {
  const events = FIXTURES.retryConfirmed()
  const retries = detectRetries(events)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].confidence, "confirmed")
  assert.equal(retries[0].tool, "bash")
})

test("retry：possible（同 tool 不同 input）", () => {
  const events = FIXTURES.retryPossible()
  const retries = detectRetries(events)
  assert.equal(retries.length, 1)
  assert.equal(retries[0].confidence, "possible")
})

test("retry：超时间窗口不产生链", () => {
  // error 在 1000ms，重试在 32000ms（超 30s 窗口）
  const events: AnalysisToolEvent[] = [
    {
      ...FIXTURES.retryConfirmed()[0],
      callID: "c1",
      startedAt: 1000,
      endedAt: 1500,
    },
    {
      ...FIXTURES.retryConfirmed()[1],
      callID: "c2",
      startedAt: 32000,
      endedAt: 33000,
    },
  ]
  const retries = detectRetries(events)
  assert.equal(retries.length, 0, "超 30s 时间窗口不应产生重试链")
})

// ============================================================
// Rule 3: Dependency 检测
// ============================================================

test("dependency：write→read 同文件", () => {
  const events = FIXTURES.writeReadDependency()
  const deps = detectDependencies(events)
  assert.equal(deps.length, 1)
  assert.equal(deps[0].chain.length, 2)
  assert.equal(deps[0].chain[0].tool, "write")
  assert.equal(deps[0].chain[1].tool, "read")
  assert.equal(deps[0].chainType, "write->read")
})

test("dependency：write→bash 执行同文件", () => {
  const events = FIXTURES.scriptExtraction()
  const deps = detectDependencies(events)
  assert.equal(deps.length, 1)
  assert.equal(deps[0].chain.length, 2)
  assert.equal(deps[0].chain[0].tool, "write")
  assert.equal(deps[0].chain[1].tool, "bash")
})

test("dependency：无关联不产生链", () => {
  const events = FIXTURES.repeatSameRead()
  const deps = detectDependencies(events)
  assert.equal(deps.length, 0, "两次独立 read 不应产生依赖链")
})

// ============================================================
// Rule 4: Latency 分析
// ============================================================

test("latency：per-Agent gap = Next.startedAt - Prev.endedAt", () => {
  const events = FIXTURES.latencyGap()
  const agents: AgentRecord[] = [
    {
      id: "run-test:0",
      label: "Agent A",
      status: "ok",
      startedAt: 900,
      durationMs: 6600,
    },
  ]
  const latency = analyzeLatency(events, agents)
  assert.equal(latency.agents.length, 1)
  const agent = latency.agents[0]
  assert.equal(agent.agentId, "run-test:0")
  assert.equal(agent.durationMs, 6600)
  // firstToolDelayMs = 1000 - 900 = 100
  assert.equal(agent.firstToolDelayMs, 100)
  // idleGaps: gap = 7000 - 1100 = 5900
  assert.equal(agent.idleGaps.length, 1)
  assert.equal(agent.idleGaps[0].gapMs, 5900)
})

test("latency：不跨 Agent 相减", () => {
  const events = FIXTURES.parallelAgents()
  const agents: AgentRecord[] = [
    {
      id: "run-test:0",
      label: "Agent A",
      status: "ok",
      startedAt: 950,
      durationMs: 400,
    },
    {
      id: "run-test:1",
      label: "Agent B",
      status: "ok",
      startedAt: 1000,
      durationMs: 200,
    },
  ]
  const latency = analyzeLatency(events, agents)
  assert.equal(latency.agents.length, 2)

  // Agent A 的 gap: 1200 - 1150 = 50ms（a1 endedAt=1100, a2 startedAt=1200, gap=100）

  // wait - let me recalculate:
  // Agent A events: a1 (startedAt=1000, endedAt=1100), a2 (startedAt=1200, endedAt=1300)
  // gap for A: 1200 - 1100 = 100
  const agentA = latency.agents.find((a) => a.agentId === "run-test:0")
  assert.ok(agentA)
  assert.equal(agentA!.idleGaps.length, 1)
  assert.equal(agentA!.idleGaps[0].gapMs, 100, "Agent A 的 gap 应为 100ms")

  // Agent B events: b1 (startedAt=1050, endedAt=1150) - only 1 event, no gaps
  const agentB = latency.agents.find((a) => a.agentId === "run-test:1")
  assert.ok(agentB)
  assert.equal(agentB!.idleGaps.length, 0, "Agent B 只有 1 个事件，无 gap")
})

test("latency：AgentRecord 缺失时 durationMs/firstToolDelayMs 为 unknown", () => {
  const events = FIXTURES.repeatSameRead()
  // 不传 agents
  const latency = analyzeLatency(events, [])
  assert.equal(latency.agents.length, 1)
  assert.equal(latency.agents[0].durationMs, "unknown")
  // firstToolDelayMs: no agent.startedAt, so unknown
  assert.equal(latency.agents[0].firstToolDelayMs, "unknown")
})

test("latency：analyzeLatency 返回 Observation 不是 Proposal", () => {
  const events = FIXTURES.latencyGap()
  const latency = analyzeLatency(events, [])
  // LatencyAnalysis 没有 category/evidenceIntegrity 等 Proposal 字段
  assert.ok("agents" in latency)
  assert.ok("totalMs" in latency)
  assert.ok(!("category" in latency), "Latency 不应有 category 字段")
  assert.ok(!("candidateConfidence" in latency), "Latency 不应有 candidateConfidence 字段")
})

// ============================================================
// signature 函数测试
// ============================================================

test("signature：相同 tool+input 产生相同签名", () => {
  const sig1 = signature("read", { filePath: "config.json" })
  const sig2 = signature("read", { filePath: "config.json" })
  assert.equal(sig1, sig2)
})

test("signature：不同 input 产生不同签名", () => {
  const sig1 = signature("read", { filePath: "config.json" })
  const sig2 = signature("read", { filePath: "other.json" })
  assert.notEqual(sig1, sig2)
})

test("signature：metadata 不影响签名", () => {
  const sig1 = signature("bash", { command: "echo hi", metadata: { ts: 1 } })
  const sig2 = signature("bash", { command: "echo hi", metadata: { ts: 2 } })
  assert.equal(sig1, sig2, "metadata 应被 normalizeInput 移除，不影响签名")
})

test("signature：嵌套属性不同产生不同签名", () => {
  // v2 bug 场景
  const sig1 = signature("bash", { options: { command: "npm test" } })
  const sig2 = signature("bash", { options: { command: "npm run build" } })
  assert.notEqual(sig1, sig2, "嵌套属性不同应产生不同签名")
})
