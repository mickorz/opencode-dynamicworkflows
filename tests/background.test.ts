/**
 * 后台工作流与 workflow_control 集成测试（P2-2 / P2-3）
 *
 * 用真实 createWorkflowTool / createWorkflowControlTool + fake client：
 *  - background:true 立即返回 runId，不阻塞
 *  - 完成后结果作为一条 prompt 回传主会话（path.id === parentSessionId）
 *  - journal 逐 agent 落盘（后台中断可续跑的基础）
 *  - workflow_control status 列出进度；stop 停止运行中的 run（abort 级联到子会话）
 *  - 前台路径不受影响（background 缺省）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import { createWorkflowTool } from "../src/tools/workflow.js"
import { createWorkflowControlTool } from "../src/tools/workflow-control.js"
import { BackgroundRunManager } from "../src/tools/background-runs.js"

type Client = PluginInput["client"]

interface FakeClientOptions {
  /** 子会话 prompt 行为：block 挂起直到外部释放（stop 测试用） */
  blockChildren?: boolean
}

function makeFakeClient(opts: FakeClientOptions = {}) {
  let seq = 0
  const childPrompts: string[] = []
  const deliveries: string[] = []
  const aborts: string[] = []
  const pending = new Map<string, { reject: (e: Error) => void }>()

  const client = {
    session: {
      create: async () => ({ data: { id: `child-${++seq}` }, error: undefined }),
      prompt: (input: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }> } }) =>
        new Promise<{ data: unknown; error: undefined }>((resolve, reject) => {
          const text = input.body.parts.map((p) => p.text ?? "").join("")
          if (input.path.id === "parent-1") {
            deliveries.push(text)
            resolve({ data: { info: {}, parts: [] }, error: undefined })
            return
          }
          childPrompts.push(text)
          if (opts.blockChildren) {
            pending.set(input.path.id, { reject })
            return // 挂起，直到 abort
          }
          resolve({
            data: { info: { tokens: { input: 3, output: 4 }, cost: 0.0012 }, parts: [{ type: "text", text: `ok:${text.slice(0, 12)}` }] },
            error: undefined,
          })
        }),
      abort: async (input: { path: { id: string } }) => {
        aborts.push(input.path.id)
        const entry = pending.get(input.path.id)
        if (entry) {
          entry.reject(new Error("aborted"))
          pending.delete(input.path.id)
        }
        return { data: undefined, error: undefined }
      },
    },
  }
  return { client: client as unknown as Client, childPrompts, deliveries, aborts }
}

function makeToolContext(directory: string): ToolContext {
  return {
    sessionID: "parent-1",
    messageID: "m-1",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as ToolContext
}

/** 轮询直到条件满足或超时 */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("background:true 立即返回 runId，完成后结果回传主会话，journal 落盘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bg-"))
  try {
    const fake = makeFakeClient()
    const manager = new BackgroundRunManager()
    const workflowTool = createWorkflowTool({ client: fake.client } as PluginInput, manager)

    const result = (await workflowTool.execute(
      {
        script: `export const meta = { name: 'bg_demo', description: '后台演示' }\nreturn await agent('任务A')`,
        background: true,
      },
      makeToolContext(dir),
    )) as { output: string; metadata: { runId: string } }

    assert.match(result.output, /后台工作流已启动/)
    assert.match(result.output, /runId: (run-\S+)/)
    const runId = result.metadata.runId

    // 完成后 delivery 到主会话
    await until(() => fake.deliveries.length >= 1)
    assert.match(fake.deliveries[0], /bg_demo 完成/)
    assert.match(fake.deliveries[0], /任务A|agent 1/)
    assert.match(fake.deliveries[0], /成本 \$0\.0012/, "cost 统计进入渲染")

    // journal 已落盘（可续跑）
    const journalFile = path.join(dir, ".opencode-workflows", "journal", `${runId}.json`)
    assert.ok(fs.existsSync(journalFile), "后台 run 的 journal 落盘")

    // status 显示已完成
    const control = createWorkflowControlTool(manager)
    const status = (await control.execute({ action: "status" }, makeToolContext(dir))) as { output: string }
    assert.match(status.output, /已完成/)
    assert.match(status.output, new RegExp(runId))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("workflow_control stop 停止运行中的后台 run，abort 级联子会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bg-stop-"))
  try {
    const fake = makeFakeClient({ blockChildren: true })
    const manager = new BackgroundRunManager()
    const workflowTool = createWorkflowTool({ client: fake.client } as PluginInput, manager)
    const control = createWorkflowControlTool(manager)

    const result = (await workflowTool.execute(
      { script: `export const meta = { name: 'bg_stop' }\nreturn await agent('挂起任务')`, background: true },
      makeToolContext(dir),
    )) as unknown as { metadata: { runId: string } }
    const runId = result.metadata.runId

    await until(() => fake.childPrompts.length >= 1, 3000)

    const stopped = (await control.execute({ action: "stop", runId }, makeToolContext(dir))) as { output: string }
    assert.match(stopped.output, /已停止/)

    // abort 级联：子会话被 abort
    await until(() => fake.aborts.length >= 1, 3000)
    // run 状态转 aborted，且失败通知回传主会话
    await until(() => fake.deliveries.length >= 1, 3000)
    assert.match(fake.deliveries[0], /aborted|停止/)
    const status = (await control.execute({ action: "status" }, makeToolContext(dir))) as { output: string }
    assert.match(status.output, /已停止/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("stop 不存在的 runId 与缺 runId 均给出明确提示", async () => {
  const manager = new BackgroundRunManager()
  const control = createWorkflowControlTool(manager)
  const ctx = makeToolContext(os.tmpdir())
  const r1 = (await control.execute({ action: "stop", runId: "run-nope" }, ctx)) as { output: string }
  assert.match(r1.output, /未找到/)
  const r2 = (await control.execute({ action: "stop" }, ctx)) as { output: string }
  assert.match(r2.output, /需要 runId/)
  const r3 = (await control.execute({ action: "status" }, ctx)) as { output: string }
  assert.match(r3.output, /没有后台工作流/)
})

test("前台路径不受影响：background 缺省时阻塞执行并返回结果", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-fg-"))
  try {
    const fake = makeFakeClient()
    const manager = new BackgroundRunManager()
    const workflowTool = createWorkflowTool({ client: fake.client } as PluginInput, manager)
    const result = (await workflowTool.execute(
      { script: `export const meta = { name: 'fg_demo' }\nreturn await agent('同步任务')` },
      makeToolContext(dir),
    )) as { output: string }
    assert.match(result.output, /fg_demo 完成/)
    assert.equal(fake.deliveries.length, 0, "前台不回传主会话")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("后台脚本校验错误同步返回，不启动 run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-bg-bad-"))
  try {
    const fake = makeFakeClient()
    const manager = new BackgroundRunManager()
    const workflowTool = createWorkflowTool({ client: fake.client } as PluginInput, manager)
    const result = (await workflowTool.execute(
      { script: `await agent('没有 meta')`, background: true },
      makeToolContext(dir),
    )) as { output: string }
    assert.match(result.output, /启动失败/)
    assert.equal(manager.status().length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
