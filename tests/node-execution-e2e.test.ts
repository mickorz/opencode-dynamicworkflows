/**
 * 节点执行记录端到端测试（Node Inspector：T06/T07/T12 的可自动化部分）
 *
 *  - parallel 同 label：node.id 与 journal key 全唯一不串位（T06）
 *  - parallel 乱序完成：agents 顺序保持定义序，各 record 状态独立（T07）
 *  - 前台 tool 全链路（真 createWorkflowTool + fake client + 真 adapter）：
 *    journal 落盘含展示元数据，失败 attempt 记录 executions（T12 数据面）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import { JournalStore } from "../src/persistence/journal.js"
import { createWorkflowTool } from "../src/tools/workflow.js"
import { BackgroundRunManager } from "../src/tools/background-runs.js"
import { textResult } from "./helpers.js"

test("parallel 同 label x5：record.id 与 journal key 全唯一，结果不串位", async () => {
  const journal = new Map<string, { result: unknown }>()
  const runner: AgentSessionRunner = {
    async run(prompt) {
      return textResult(`结果:${prompt}`)
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'dup_label' }
const rs = await parallel(['a', 'b', 'c', 'd', 'e'].map(x => () => agent('任务 ' + x, { label: '同名' })))
return rs`,
    { agent: runner, runId: "run-dup", onAgentJournal: (e) => journal.set(e.key, { result: e.result }) },
  )
  // id 与 journal key 全唯一（runId:callIndex，label 重复无影响）
  const ids = result.agents.map((a) => a.id)
  assert.equal(new Set(ids).size, 5)
  assert.deepEqual(ids, ["run-dup:0", "run-dup:1", "run-dup:2", "run-dup:3", "run-dup:4"])
  assert.equal(new Set(journal.keys()).size, 5)
  // 结果按定义序对应，不串位
  assert.deepEqual(result.result, ["结果:任务 a", "结果:任务 b", "结果:任务 c", "结果:任务 d", "结果:任务 e"])
  assert.equal(journal.get("run-dup:3")!.result, "结果:任务 d")
})

test("parallel 乱序完成：agents 顺序仍为定义序，各 record 状态独立", async () => {
  // gate 模式：三个 agent 依次延迟释放（慢的最先定义）
  const releaseQueue: Array<() => void> = []
  const runner: AgentSessionRunner = {
    run(_prompt, options) {
      return new Promise((resolve) => {
        releaseQueue.push(() => resolve(textResult("done")))
        // 触发 running 态 record 更新路径（模拟 onSessionCreated 无关的 usage 事件可省）
        options?.onUsage?.({ input: 1, output: 1, total: 2 })
      })
    },
  }
  const updatesByLabel = new Map<string, string[]>()
  const workflow = runWorkflow(
    `export const meta = { name: 'out_of_order' }
const rs = await parallel([
  () => agent('慢任务', { label: 'A' }),
  () => agent('快任务', { label: 'B' }),
  () => agent('中任务', { label: 'C' }),
])
return rs.length`,
    {
      agent: runner,
      runId: "run-ooo",
      onAgentUpdate: (record) => {
        const list = updatesByLabel.get(record.label) ?? []
        list.push(record.status)
        updatesByLabel.set(record.label, list)
      },
    },
  )
  // 等三个 agent 都进入 running（gate 收集满）
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(releaseQueue.length, 3)
  // 乱序释放：C 先完成、A 最后
  releaseQueue[2]()
  await new Promise((resolve) => setTimeout(resolve, 30))
  releaseQueue[1]()
  await new Promise((resolve) => setTimeout(resolve, 30))
  releaseQueue[0]()
  const result = await workflow
  // 顺序保持定义序
  assert.deepEqual(
    result.agents.map((a) => a.label),
    ["A", "B", "C"],
  )
  // 各自独立到达终态
  assert.ok(result.agents.every((a) => a.status === "ok"))
  assert.deepEqual(updatesByLabel.get("C")?.at(-1), "ok")
  assert.deepEqual(updatesByLabel.get("A")?.at(-1), "ok")
})

test("前台 tool 全链路：journal entry 含展示元数据，失败 attempt 记录 executions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-node-"))
  try {
    let seq = 0
    let calls = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++seq}` }, error: undefined }),
        prompt: (input: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }> } }) =>
          new Promise<{ data: unknown; error: undefined }>((resolve, reject) => {
            const text = input.body.parts.map((p) => p.text ?? "").join("")
            if (input.path.id !== "parent-1") {
              calls++
              if (text.includes("注定失败")) {
                reject(new Error("模拟 provider 500"))
                return
              }
            }
            resolve({
              data: { info: { tokens: { input: 3, output: 4 } }, parts: [{ type: "text", text: `ok:${text.slice(0, 8)}` }] },
              error: undefined,
            })
          }),
        abort: async () => ({ data: undefined, error: undefined }),
      },
    }
    const manager = new BackgroundRunManager()
    const workflowTool = createWorkflowTool({ client } as unknown as PluginInput, manager)
    const context = {
      sessionID: "parent-1",
      messageID: "m-1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    } as unknown as ToolContext

    const output = await workflowTool.execute(
      {
        script: `export const meta = { name: 'e2e_node' }
const ok = await agent('正常任务', { label: '成功节点' })
let failed = null
try {
  failed = await agent('注定失败的任务', { label: '失败节点' })
} catch (e) {
  return { ok, failed: 'captured' }
}
return { ok, failed }`,
      },
      context,
    )

    // runId 从 tool 返回 metadata 直接取（C 通道契约；ToolResult 是 union，先窄化）
    const returned = typeof output === "object" ? output : undefined
    const runId = (returned?.metadata as { runId?: string } | undefined)?.runId
    assert.ok(runId, "返回 metadata 应含 runId")

    // journal 落盘：成功 entry 含展示元数据
    const store = new JournalStore(dir)
    const entries = store.load(runId)
    const okEntry = entries.get(`${runId}:0`)
    assert.ok(okEntry, "成功节点 entry 存在")
    assert.equal(okEntry!.label, "成功节点")
    assert.equal(okEntry!.sessionId, "child-1")
    assert.equal(okEntry!.outputType, "text")
    assert.equal(okEntry!.executionId, `${runId}:0:1`)
    assert.equal(typeof okEntry!.prompt, "string")
    assert.deepEqual(okEntry!.usage, { inputTokens: 3, outputTokens: 4 })

    // 失败节点（不可恢复错误直接抛出）：executions 记录失败尝试，无 hash/result
    // 注意：脚本 catch 住了 non-recoverable 抛错，workflow 正常返回
    const failEntry = entries.get(`${runId}:1`)
    assert.ok(failEntry?.executions?.length, "失败节点应有 executions 记录")
    assert.equal(failEntry!.executions![0].status, "failed")
    assert.equal(failEntry!.executions![0].executionId, `${runId}:1:1`)
    assert.equal(failEntry!.hash, undefined, "失败不写 hash（resume 安全）")
    assert.equal(failEntry!.result, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
