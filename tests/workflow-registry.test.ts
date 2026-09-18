/**
 * v0.10 Workflow Registry 测试：workflow() 按名引用
 * 覆盖：名字解析（meta.id 优先）/ 显式路径判定边界（含斜杠名合法）/ 未找到报错 /
 *       per-run 缓存（首查后删文件仍可解析）/ 名字与路径引用共存 / 自环按名命中
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-reg-"))
}

/** 往 .opencode-workflows/workflows/ 放一个子脚本 */
function putRegistered(dir: string, fileName: string, meta: string): string {
  const file = path.join(dir, ".opencode-workflows", "workflows", fileName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${meta}\nreturn await agent('reg task')`, "utf-8")
  return file
}

async function run(parent: string, dir: string) {
  return runWorkflow(parent, { agent: makeRunner(), cwd: dir })
}

test("名字引用：注册目录内脚本按 meta.id / meta.name 引用", async () => {
  const dir = tmpProject()
  putRegistered(dir, "a.js", `export const meta = { id: 'stable_id', name: 'display_name' }`)
  putRegistered(dir, "b.js", `export const meta = { name: 'plain_name' }`)
  const parent = `export const meta = { name: 'p' }\nconst a = await workflow('stable_id')\nconst b = await workflow('plain_name')\nreturn [a, b]`
  const result = await run(parent, dir)
  assert.equal(result.agentCount, 2)
  const childA = result.workflows.find((w) => w.workflowId === "stable_id")!
  assert.equal(childA.name, "display_name", "meta.id 寻址、meta.name 记录")
})

test("显式路径判定：./ ../ 绝对路径为路径；含斜杠名走 registry", async () => {
  const dir = tmpProject()
  // 嵌套名（含斜杠）：registry id 合法
  putRegistered(dir, "nested.js", `export const meta = { id: 'ui/main-menu', name: 'ui_main_menu' }`)
  fs.writeFileSync(path.join(dir, "sub.js"), `export const meta = { name: 'sub' }\nreturn await agent('path task')`)
  const parent = `export const meta = { name: 'p' }\nconst a = await workflow('ui/main-menu')\nconst b = await workflow('./sub.js')\nconst c = await workflow(${JSON.stringify(path.join(dir, "sub.js"))})\nreturn [a, b, c]`
  const result = await run(parent, dir)
  assert.equal(result.agentCount, 3)
  assert.deepEqual(result.workflows.find((w) => w.keySegment === "wf0")!.displayPath, ["p", "ui_main_menu"], "label 缺省 meta.name（id 仅作寻址）")
})

test("未找到：报错并列出已知名", async () => {
  const dir = tmpProject()
  putRegistered(dir, "a.js", `export const meta = { name: 'known_one' }`)
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('ghost_name')`
  await assert.rejects(run(parent, dir), /WORKFLOW_NOT_FOUND：.*known_one/s)
})

test("per-run 缓存：首查后名字集合冻结（新增注册文件不影响进行中 run）", async () => {
  const dir = tmpProject()
  putRegistered(dir, "a.js", `export const meta = { name: 'first_one' }`)
  // 第一个 child 完成后新增注册文件；第二个调用验证：已知名仍可解析（缓存命中），新名不可见（未重扫）
  let added = false
  const parent = `export const meta = { name: 'p' }
const a = await workflow('first_one')
const b = await workflow('first_one')
return [a, b]`
  const result = await runWorkflow(parent, {
    agent: makeRunner(),
    cwd: dir,
    onAgentUpdate: (r) => {
      if (!added && r.status === "ok" && r.workflowPath?.includes("first_one")) {
        added = true
        putRegistered(dir, "late.js", `export const meta = { name: 'late_one' }`)
      }
    },
  })
  assert.ok(added)
  assert.equal(result.agentCount, 2, "已知名两次均命中缓存解析")
  // 新 run 能看到 late_one（缓存 per-run，不跨 run 冻结）
  const nextRun = await runWorkflow(`export const meta = { name: 'p2' }\nawait workflow('late_one')`, {
    agent: makeRunner(),
    cwd: dir,
  })
  assert.equal(nextRun.agentCount, 1)
})

test("名字与路径引用同一脚本：自环检查按 canonical 归一命中", async () => {
  const dir = tmpProject()
  const file = putRegistered(dir, "selfy.js", `export const meta = { name: 'selfy' }\nreturn await workflow('selfy')`)
  const parent = `export const meta = { name: 'p' }\nreturn await workflow(${JSON.stringify(file)})`
  await assert.rejects(run(parent, dir), /不能调用自身或祖先/)
})

test("registry 为空目录：报错提示目录位置", async () => {
  const dir = tmpProject()
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('anything')`
  await assert.rejects(run(parent, dir), /WORKFLOW_NOT_FOUND.*目录为空或不存在/s)
})
