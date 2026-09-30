/**
 * question 型 checkpoint 测试（#35）
 * 覆盖：options 触发挂起（CHECKPOINT_PENDING + journal 标记 + 载荷）、
 *       reply 覆写后 resume 回放返回答案、拒绝强停止、未作答续跑重现挂起、
 *       hash 纳入 options、无 options 保持权限型流程
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow, CHECKPOINT_PENDING_MARKER } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

function makeRunner() {
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 12)}`, sessionId: "s", type: "text" }
    },
  }
  return { runner, prompts }
}

const Q_OPTS = [{ label: "预发环境", description: "先灰度" }, { label: "生产环境", description: "全量" }]

const SCRIPT = `export const meta = { name: 'qcp' }
phase('闸门')
const before = await agent('准备就绪')
const answer = await checkpoint('选择部署目标', {
  header: '部署目标',
  options: [
    { label: '预发环境', description: '先灰度' },
    { label: '生产环境', description: '全量' },
  ],
})
phase('执行')
const after = await agent('部署到 ' + String(answer && answer[0]))
return { answer, after }`

function runWith(script: string, extra: Partial<Parameters<typeof runWorkflow>[1]> = {}) {
  const { runner, prompts } = makeRunner()
  const journal = new Map<string, JournalEntry>()
  const p = runWorkflow(script, {
    onAgentJournal: (e) => journal.set(e.key, e),
    ...extra,
    agent: runner,
  })
  return { p, journal, prompts }
}

test("question 型 checkpoint：抛 PENDING，journal 写挂起标记，载荷含官方 Prompt 形态", async () => {
  const { p, journal } = runWith(SCRIPT)
  await assert.rejects(p, (e: any) => {
    assert.equal(e.code, "CHECKPOINT_PENDING")
    const d = e.details
    assert.ok(d.journalKey.includes(":1"), "journalKey 为第二个调用位")
    assert.equal(d.question.header, "部署目标")
    assert.equal(d.question.options.length, 2)
    assert.equal(d.question.multiple, false)
    assert.equal(d.question.custom, true)
    return true
  })
  const entry = [...journal.values()].find((e) => e.result === CHECKPOINT_PENDING_MARKER)
  assert.ok(entry, "journal 含挂起标记 entry")
  assert.equal(entry.question?.header, "部署目标")
})

test("reply 覆写答案后 resume：checkpoint 回放返回答案，脚本继续执行", async () => {
  const { p, journal } = runWith(SCRIPT)
  const runId = await p.catch((e: any) => e.details.journalKey.split(":")[0])
  // 模拟 checkpoint_reply：覆写标记 entry
  const key = [...journal.keys()].find((k) => journal.get(k)!.result === CHECKPOINT_PENDING_MARKER)!
  journal.get(key)!.result = ["预发环境"]

  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(SCRIPT, {
    agent: runner,
    resumeJournal: journal,
    runId,
    onAgentJournal: (e) => journal.set(e.key, e),
  })
  const out = JSON.parse(JSON.stringify(result.result))
  assert.deepEqual(out.answer, ["预发环境"], "回放返回作答")
  assert.match(out.after, /预发环境/, "答案驱动后续节点")
  assert.equal(prompts.filter((x) => x.includes("准备就绪")).length, 0, "checkpoint 前 agent 回放不重烧")
  assert.equal(prompts.filter((x) => x.includes("部署到")).length, 1, "后续节点真实执行")
})

test("reply 拒绝后 resume：CHECKPOINT_REJECTED 强停止，后续不执行", async () => {
  const { p, journal } = runWith(SCRIPT)
  const runId = await p.catch((e: any) => e.details.journalKey.split(":")[0])
  const key = [...journal.keys()].find((k) => journal.get(k)!.result === CHECKPOINT_PENDING_MARKER)!
  journal.get(key)!.result = false
  const { runner, prompts } = makeRunner()
  await assert.rejects(
    runWorkflow(SCRIPT, { agent: runner, resumeJournal: journal, runId }),
    (e: any) => e.code === "CHECKPOINT_REJECTED",
  )
  assert.equal(prompts.filter((x) => x.includes("部署到")).length, 0)
})

test("未作答就续跑：确定性重现挂起（不弹不卡）", async () => {
  const { p, journal } = runWith(SCRIPT)
  const runId = await p.catch((e: any) => e.details.journalKey.split(":")[0])
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(SCRIPT, { agent: runner, resumeJournal: journal, runId }),
    (e: any) => e.code === "CHECKPOINT_PENDING",
  )
})

test("hash 纳入 options：改选项后续跑 miss，重新挂起", async () => {
  const { p, journal } = runWith(SCRIPT)
  await p.catch(() => {})
  const key = [...journal.keys()].find((k) => journal.get(k)!.result === CHECKPOINT_PENDING_MARKER)!
  journal.get(key)!.result = ["预发环境"]
  // 改 options（生产在前）——hash 变化，回放 miss，应重新挂起而非返回旧答案
  const changed = SCRIPT.replace("{ label: '预发环境', description: '先灰度' },\n    { label: '生产环境', description: '全量' },", "{ label: '生产环境', description: '全量' },\n    { label: '预发环境', description: '先灰度' },")
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(changed, { agent: runner, resumeJournal: journal }),
    (e: any) => e.code === "CHECKPOINT_PENDING",
  )
})

test("无 options：保持权限型 confirm 流程（不 PENDING）", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'qcp_plain' }
const ok = await checkpoint('直接确认？')
return { ok }`,
    { agent: runner, confirm: async () => true },
  )
  assert.equal((result.result as any).ok, true)
})
