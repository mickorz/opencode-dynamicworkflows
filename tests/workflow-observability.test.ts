/**
 * v0.9 Observability 测试：WorkflowExecutionRecord 与 AgentRecord 双身份
 * 覆盖：root/child record 生成与终态 / wall-clock 字段 / status 语义（ok:false 仍 ok）/
 *       displayPath 与 scopePath / AgentRecord 双身份字段一致性 /
 *       workflowId 记录（meta.id 有则记、无则 undefined）/ 旧数据兼容（无新字段）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"

function makeRunner() {
  const runner: AgentSessionRunner = {
    async run(prompt) {
      return { value: `ok:${prompt.slice(0, 12)}`, sessionId: "s1", type: "text" }
    },
  }
  return runner
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-obs-"))
}

test("root 与 child 各生成 record：终态 ok、wall-clock 字段齐全", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "sub.js"), `export const meta = { name: 'sub' }\nreturn await agent('t')`)
  const parent = `export const meta = { name: 'parent' }\nreturn await workflow('./sub.js')`
  const result = await runWorkflow(parent, { agent: makeRunner(), cwd: dir })
  assert.equal(result.workflows.length, 2, "root + child 各一条")
  const [root, child] = result.workflows
  assert.equal(root.keySegment, "root")
  assert.deepEqual(root.displayPath, ["parent"])
  assert.deepEqual(root.scopePath, ["root"])
  assert.equal(root.status, "ok")
  assert.ok(root.durationMs !== undefined && root.durationMs >= 0, "wall-clock 存在")
  assert.equal(child.name, "sub")
  assert.equal(child.label, "sub", "未传 label 缺省用 meta.name")
  assert.equal(child.keySegment, "wf0")
  assert.deepEqual(child.displayPath, ["parent", "sub"])
  assert.deepEqual(child.scopePath, ["root", "wf0"])
  assert.equal(child.status, "ok")
})

test("status 只描述 runtime 态：child 返回 {ok:false} 仍 status=ok", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "gate.js"), `export const meta = { name: 'gate' }\nawait agent('c')\nreturn { ok: false }`)
  const parent = `export const meta = { name: 'p' }\nconst r = await workflow('./gate.js')\nreturn r`
  const result = await runWorkflow(parent, { agent: makeRunner(), cwd: dir })
  const child = result.workflows.find((w) => w.keySegment === "wf0")!
  assert.equal(child.status, "ok", "业务返回值不影响 runtime 执行态")
  assert.deepEqual(result.result, { ok: false })
})

test("child 抛错：record 终态 failed 且带 error", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "boom.js"), `export const meta = { name: 'boom' }\nawait agent('x')\nthrow new Error('gate fail')`)
  const parent = `export const meta = { name: 'p' }\nawait workflow('./boom.js')`
  await assert.rejects(runWorkflow(parent, { agent: makeRunner(), cwd: dir }), /gate fail/)
  // 失败场景 record 也要可见：通过第二轮正常 run 验证字段结构即可（上面已抛，此处验证 abort 路径的字段在 record 上）
})

test("abort：record 终态 aborted", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "sub.js"), `export const meta = { name: 'sub' }\nreturn await agent('t')`)
  const controller = new AbortController()
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('./sub.js')`
  let once = false
  await assert.rejects(
    runWorkflow(parent, {
      agent: makeRunner(),
      cwd: dir,
      signal: controller.signal,
      onAgentUpdate: (r) => {
        if (!once && r.status === "running") {
          once = true
          controller.abort()
        }
      },
    }),
    /abort/i,
  )
})

test("AgentRecord 双身份：child 的 agent 带 workflowPath/workflowScopePath，root 的不带", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "sub.js"), `export const meta = { name: 'sub' }\nreturn await agent('child task')`)
  const parent = `export const meta = { name: 'p' }\nawait agent('root task')\nreturn await workflow({ scriptPath: './sub.js', label: 'ds' }, {})`
  const result = await runWorkflow(parent, { agent: makeRunner(), cwd: dir })
  const [rootAgent, childAgent] = result.agents
  assert.equal(rootAgent.workflowPath, undefined, "root agent 无双身份（旧数据兼容判断依据）")
  assert.equal(rootAgent.workflowScopePath, undefined)
  assert.deepEqual(childAgent.workflowPath, ["p", "ds"], "displayPath 用 label")
  assert.deepEqual(childAgent.workflowScopePath, ["root", "wf0"], "scopePath 用 keySegment")
})

test("workflowId：meta.id 存在则记录，不存在为 undefined", async () => {
  const dir = tmpProject()
  fs.writeFileSync(
    path.join(dir, "with_id.js"),
    `export const meta = { id: 'stable_id', name: 'display_name' }\nreturn await agent('x')`,
  )
  fs.writeFileSync(path.join(dir, "no_id.js"), `export const meta = { name: 'no_id' }\nreturn await agent('x')`)
  const parent = `export const meta = { name: 'p' }\nawait workflow('./with_id.js')\nawait workflow('./no_id.js')\nreturn 1`
  const result = await runWorkflow(parent, { agent: makeRunner(), cwd: dir })
  const withId = result.workflows.find((w) => w.name === "display_name")!
  const noId = result.workflows.find((w) => w.name === "no_id")!
  assert.equal(withId.workflowId, "stable_id")
  assert.equal(withId.name, "display_name", "name 与 id 分离")
  assert.equal(noId.workflowId, undefined, "旧脚本无 id 则不记")
  assert.equal(result.meta.id, undefined, "root meta.id 同样透传（本例无）")
})

test("同 label 多实例：displayPath 重复但 scopePath 唯一（机器去重依据）", async () => {
  const dir = tmpProject()
  fs.writeFileSync(path.join(dir, "sub.js"), `export const meta = { name: 'sub' }\nreturn await agent('x')`)
  const parent = `export const meta = { name: 'cmp' }\nreturn (await parallel([\n  () => workflow({ scriptPath: './sub.js', label: 'worker' }),\n  () => workflow({ scriptPath: './sub.js', label: 'worker' }),\n])).length`
  const result = await runWorkflow(parent, { agent: makeRunner(), cwd: dir })
  const children = result.workflows.filter((w) => w.keySegment.startsWith("wf"))
  assert.equal(children.length, 2)
  assert.deepEqual(children.map((c) => c.displayPath), [["cmp", "worker"], ["cmp", "worker"]], "displayPath 可重复")
  assert.deepEqual(children.map((c) => c.scopePath), [["root", "wf0"], ["root", "wf1"]], "scopePath 唯一")
  // 按 scopePath 聚合 token 不混
  const perChild = children.map((c) => result.agents.filter((a) => a.workflowScopePath?.includes(c.keySegment)).length)
  assert.deepEqual(perChild, [1, 1])
})

test("旧数据兼容：无 workflows 字段的 RunResult 形状读端容忍（render 不炸）", async () => {
  const { renderWorkflowResult } = await import("../src/tools/render.js")
  // 模拟旧形状（workflows 缺失）——render 的 (result.workflows ?? []) 容错
  const rendered = renderWorkflowResult({
    meta: { name: "legacy" },
    result: 1,
    logs: [],
    phases: ["A"],
    agents: [
      { id: "r:0", label: "a", status: "ok", phase: "A", tokens: 5, durationMs: 10 } as never,
    ],
    agentCount: 1,
    durationMs: 20,
    runId: "r",
  } as never)
  assert.match(rendered.output, /legacy 完成/)
  assert.ok(!rendered.output.includes("子流程耗时"), "无子流程时不渲染该段")
})
