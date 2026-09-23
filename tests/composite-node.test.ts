/**
 * Composite 组合节点测试（V1 P0-3 sequence / P0-6 fallback）
 * 覆盖：串行 prev 传递、成功返回最后值、可恢复失败终止返回 null、null/{ok:false} 不等于失败、
 *       结构性错误上抛、中止上抛、与 child workflow 集成、journal 透明性、resume 兼容
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow, type WorkflowRunOptions } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

function makeRunner() {
  const calls: Array<AgentRunOptions | undefined> = []
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push(options)
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 32)}`, sessionId: `sess-${prompts.length}`, type: "text" }
    },
  }
  return { runner, calls, prompts }
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-composite-"))
}

function put(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
  return file
}

async function run(script: string, dir: string, extra: Partial<WorkflowRunOptions> = {}) {
  const { runner, calls, prompts } = makeRunner()
  const result = await runWorkflow(script, { ...extra, agent: runner, cwd: dir })
  return { result, calls, prompts }
}

// ── sequence 基础语义 ──

test("sequence：串行执行、prev 传递、返回最后一个节点值", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'seq_basic' }
const r = await sequence([
  () => 'step1',
  (prev) => prev + '-step2',
  (prev) => prev + '-step3',
])
await agent('bookkeeping')
return r`,
    dir,
  )
  assert.equal(result.result, "step1-step2-step3")
})

test("sequence：节点内的 agent 正常执行且被记账", async () => {
  const dir = tmpProject()
  const { result, calls } = await run(
    `export const meta = { name: 'seq_agent' }
const r = await sequence([
  () => agent('first task'),
  (prev) => agent('second task with ' + prev.slice(0, 8)),
])
return r`,
    dir,
  )
  assert.equal(calls.length, 2)
  assert.equal(result.agentCount, 2)
  assert.match(String(result.result), /^ok:second task with/)
})

test("sequence：节点返回 null 是 success，后续节点以 null 继续（不中断）", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'seq_null' }
const seen = []
const r = await sequence([
  () => { seen.push('a'); return null },
  (prev) => { seen.push('b:' + String(prev)); return 'final' },
])
await agent('bookkeeping')
return { r, seen }`,
    dir,
  )
  assert.equal((result.result as any).seen.join("|"), "a|b:null")
  assert.equal((result.result as any).r, "final")
})

test("sequence：节点返回 {ok:false} 是 success（执行态与业务结果分离）", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'seq_biz' }
const r = await sequence([
  () => ({ ok: false, reason: '业务否决' }),
  (prev) => prev.ok === false ? 'compensated' : 'unexpected',
])
await agent('bookkeeping')
return r`,
    dir,
  )
  assert.equal(result.result, "compensated")
})

test("sequence：可恢复失败立即停止并返回 null，后续节点不执行", async () => {
  const dir = tmpProject()
  const { result, calls } = await run(
    `export const meta = { name: 'seq_fail' }
const seen = []
const r = await sequence([
  () => { seen.push('a'); return 'x' },
  () => { seen.push('b'); throw new Error('节点崩了') },
  () => { seen.push('c'); return 'never' },
])
await agent('bookkeeping')
return { r, seen }`,
    dir,
  )
  assert.equal((result.result as any).r, null)
  assert.equal((result.result as any).seen.join("|"), "a|b")
  assert.equal(calls.length, 1, "仅 bookkeeping agent 被调用，失败后节点不执行")
  assert.ok(result.logs.some((l: string) => l.includes("sequence[1] 失败")), "失败记入日志")
})

test("sequence：结构性错误（非函数数组）直接 throw", async () => {
  const dir = tmpProject()
  await assert.rejects(
    run(
      `export const meta = { name: 'seq_invalid' }
await sequence([agent('a'), agent('b')])
return 'never'`,
      dir,
    ),
    /非空函数数组/,
  )
})

test("sequence：空数组同样是结构性错误", async () => {
  const dir = tmpProject()
  await assert.rejects(
    run(
      `export const meta = { name: 'seq_empty' }
await sequence([])
return 'never'`,
      dir,
    ),
    /非空函数数组/,
  )
})

test("sequence：中止面上节点 reject 时上抛 WORKFLOW_ABORTED（cancelled 传递）", async () => {
  const dir = tmpProject()
  const controller = new AbortController()
  const runner: AgentSessionRunner = {
    async run(prompt) {
      // 首 agent 执行中触发外部中止（fake runner 不响应 signal，正常返回）
      if (prompt.includes("trigger-abort")) controller.abort()
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'seq_abort' }
const r = await sequence([
  () => agent('trigger-abort'),
  () => { throw new Error('节点在中止后拒绝') },
])
return r`,
      { agent: runner, cwd: dir, signal: controller.signal },
    ),
    /abort/i,
  )
})
