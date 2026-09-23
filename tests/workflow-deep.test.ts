/**
 * 分支 A：Deep Workflow + Nested Resume 测试
 * 覆盖：三层嵌套执行 / 深层 journal key 全链段（不碰撞） / 深层自环（隔层祖先）/
 *       maxWorkflowDepth 覆盖 / 深层统计递归 / resume 组合矩阵
 *       （孙层 agent 变更只重跑该 scope / 父调换 child 顺序后续重跑 / workflowLabel 落 journal）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

function makeRunner() {
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 16)}`, sessionId: `s${prompts.length}`, type: "text" }
    },
  }
  return { runner, prompts }
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-deep-"))
}

function put(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
  return file
}

test("三层嵌套：执行成功且 journal key 全链段不碰撞", async () => {
  const dir = tmpProject()
  put(dir, "l3.js", `export const meta = { name: 'l3' }\nreturn await agent('leaf task')`)
  // l1 有自己的 agent + 孙层，两者 key 前缀必须可区分（v0.8 单段 key 在此会碰撞）
  put(dir, "l2.js", `export const meta = { name: 'l2' }\nawait agent('mid task')\nreturn await workflow('./l3.js')`)
  put(dir, "l1.js", `export const meta = { name: 'l1' }\nawait agent('top task')\nreturn await workflow('./l2.js')`)
  const parent = `export const meta = { name: 'root' }\nreturn await workflow('./l1.js')`

  const journal = new Map<string, JournalEntry & { key: string }>()
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(parent, {
    agent: runner,
    cwd: dir,
    runId: "run-deep",
    onAgentJournal: (e) => journal.set(e.key, e as JournalEntry & { key: string }),
  })
  assert.equal(result.agentCount, 3)
  assert.equal(prompts.length, 3)
  // key 矩阵：l1 agent / l2 agent / l3 agent 三段不同
  assert.deepEqual(
    Array.from(journal.keys()).sort(),
    ["run-deep:wf0:0", "run-deep:wf0:wf0:0", "run-deep:wf0:wf0:wf0:0"],
    "全链段：本层 agent 与孙层 agent 不碰撞",
  )
  // workflowLabel 断点反查（分支 A）：孙层 agent 带 l3，l1 层带 l1
  assert.equal(journal.get("run-deep:wf0:0")?.workflowLabel, "l1")
  assert.equal(journal.get("run-deep:wf0:wf0:0")?.workflowLabel, "l2")
  assert.equal(journal.get("run-deep:wf0:wf0:wf0:0")?.workflowLabel, "l3")
  // 统计递归：4 条 record（root + 3 层）
  assert.equal(result.workflows.length, 4)
  assert.deepEqual(
    result.workflows.filter((w) => w.keySegment !== "root").map((w) => w.scopePath),
    [["root", "wf0"], ["root", "wf0", "wf0"], ["root", "wf0", "wf0", "wf0"]],
  )
})

test("深度覆盖：maxWorkflowDepth=1 恢复单层限制", async () => {
  const dir = tmpProject()
  put(dir, "l2.js", `export const meta = { name: 'l2' }\nreturn await agent('x')`)
  put(dir, "l1.js", `export const meta = { name: 'l1' }\nreturn await workflow('./l2.js')`)
  const parent = `export const meta = { name: 'root' }\nawait workflow('./l1.js')`
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(parent, { agent: runner, cwd: dir, maxWorkflowDepth: 1 }),
    /嵌套深度超限（当前最多 1 层/,
  )
})

test("深层自环：隔层祖先同样被沿链拦下", async () => {
  const dir = tmpProject()
  // l3 调 l1（隔两层祖先）
  put(dir, "l3.js", `export const meta = { name: 'l3' }\nawait agent('x')\nreturn await workflow('./l1.js')`)
  put(dir, "l2.js", `export const meta = { name: 'l2' }\nreturn await workflow('./l3.js')`)
  put(dir, "l1.js", `export const meta = { name: 'l1' }\nreturn await workflow('./l2.js')`)
  const parent = `export const meta = { name: 'root' }\nawait workflow('./l1.js')`
  const { runner } = makeRunner()
  await assert.rejects(runWorkflow(parent, { agent: runner, cwd: dir }), /不能调用自身或祖先/)
})

test("resume 组合矩阵：孙层 agent 变更只重跑该 scope，其余层回放", async () => {
  const dir = tmpProject()
  put(dir, "l3.js", `export const meta = { name: 'l3' }\nreturn await agent('leaf V1')`)
  put(dir, "l2.js", `export const meta = { name: 'l2' }\nawait agent('mid')\nreturn await workflow('./l3.js')`)
  put(dir, "l1.js", `export const meta = { name: 'l1' }\nawait agent('top')\nreturn await workflow('./l2.js')`)
  const parent = `export const meta = { name: 'root' }\nreturn await workflow('./l1.js')`

  // 第一轮：收集 journal
  const journal = new Map<string, JournalEntry>()
  {
    const { runner } = makeRunner()
    await runWorkflow(parent, { agent: runner, cwd: dir, runId: "run-m", onAgentJournal: (e) => journal.set(e.key, e) })
  }
  // 变更：仅孙层（l3）agent prompt
  put(dir, "l3.js", `export const meta = { name: 'l3' }\nreturn await agent('leaf V2')`)
  // 第二轮：resume
  const { runner: r2, prompts: p2 } = makeRunner()
  await runWorkflow(parent, { agent: r2, cwd: dir, runId: "run-m", resumeJournal: journal })
  assert.deepEqual(p2, ["leaf V2"], "仅孙层重跑；l1/l2 层与 root 全部回放零调用")
})

test("resume 组合矩阵：父调换 child 顺序，后续 child 全部重跑（语义锚定）", async () => {
  const dir = tmpProject()
  put(dir, "a.js", `export const meta = { name: 'a' }\nreturn await agent('A task')`)
  put(dir, "b.js", `export const meta = { name: 'b' }\nreturn await agent('B task')`)
  const parentAB = `export const meta = { name: 'root' }\nawait workflow('./a.js')\nreturn await workflow('./b.js')`
  const parentBA = `export const meta = { name: 'root' }\nawait workflow('./b.js')\nreturn await workflow('./a.js')`

  const journal = new Map<string, JournalEntry>()
  {
    const { runner } = makeRunner()
    await runWorkflow(parentAB, { agent: runner, cwd: dir, runId: "run-swap", onAgentJournal: (e) => journal.set(e.key, e) })
  }
  // 调换后续跑：wfN 按调用顺序重排，A/B 的 key 全变（run:wf0/wf1 对调），全部 miss 重跑
  // ——这是计划明示接受的语义（childSeq 位置寻址，不做内容寻址）
  const { runner: r2, prompts: p2 } = makeRunner()
  await runWorkflow(parentBA, { agent: r2, cwd: dir, runId: "run-swap", resumeJournal: journal })
  assert.deepEqual(
    p2.slice().sort(),
    ["A task", "B task"],
    "调换顺序后两个 child 的 wfN 都重排，全部重跑（语义锚定：不做内容寻址）",
  )
})

test("TUI 全链分组：深层 workflowPath 完整链显示且分组唯一", async () => {
  const { buildSidebarRows, parseWorkflowMetadata } = await import("../src/tui/workflow-store.js")
  const progress = parseWorkflowMetadata({
    runId: "r",
    agents: [
      { id: "1", label: "top", status: "ok", phase: "▸ l1 / P1", workflowPath: ["root", "l1"] },
      { id: "2", label: "mid", status: "ok", phase: "▸ l2 / P2", workflowPath: ["root", "l1", "l2"] },
      { id: "3", label: "leaf", status: "ok", phase: "▸ l3 / P3", workflowPath: ["root", "l1", "l2", "l3"] },
      { id: "4", label: "back", status: "ok", phase: "▸ l1 / P1", workflowPath: ["root", "l1"] },
    ],
  })!
  const rows = buildSidebarRows(progress)
  assert.deepEqual(
    rows.map((r) => (r.kind === "composite" ? `[${r.title}]` : r.kind === "phase" ? `#${r.title}` : r.kind === "workflow" ? `@${r.title}` : r.node.label)),
    ["@root / l1", "#▸ l1 / P1", "top", "@root / l1 / l2", "#▸ l2 / P2", "mid", "@root / l1 / l2 / l3", "#▸ l3 / P3", "leaf", "@root / l1", "#▸ l1 / P1", "back"],
    "全链 join 分组：深层各成组，回到浅层重新起组",
  )
})
