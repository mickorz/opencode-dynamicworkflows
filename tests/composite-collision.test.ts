/**
 * Composite 身份冲突测试：并行兄弟子 Workflow 各含组合节点时
 * 进度收集不因 cmpN 重名而错误覆盖
 *
 * 问题：CompositeRecord.id 在每个 scope 内从 cmp0 开始，
 *       但全部推入 shared.composites 同一数组。
 *       前台/后台进度收集只按裸 id 匹配，兄弟 scope 的 cmp0 会互相覆盖。
 * 修正：匹配键改用 scopePath + compositePath 组合，整 run 内唯一。
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { CompositeRecord } from "../src/types/index.js"

function makeRunner(): AgentSessionRunner {
  return {
    async run(prompt) {
      return { value: `ok:${prompt.slice(0, 8)}`, sessionId: "s1", type: "text" }
    },
  }
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-cmp-coll-"))
}

test("并行兄弟子 Workflow 各含 sequence：cmpN 重名不冲突", async () => {
  const dir = tmpProject()
  fs.writeFileSync(
    path.join(dir, "child.js"),
    `export const meta = { name: 'child' }\n` +
      `const r = await sequence([() => agent('a'), () => agent('b')])\n` +
      `return r`,
  )
  const parent =
    `export const meta = { name: 'parent' }\n` +
    `return (await parallel([\n` +
    `  () => workflow('./child.js'),\n` +
    `  () => workflow('./child.js'),\n` +
    `])).length`

  // 用与生产代码相同的匹配键逻辑收集 composite 更新
  const collected: CompositeRecord[] = []
  const result = await runWorkflow(parent, {
    agent: makeRunner(),
    cwd: dir,
    onCompositeUpdate: (record) => {
      const key = record.scopePath.join(":") + ":" + record.compositePath.join(":")
      const index = collected.findIndex(
        (c) => c.scopePath.join(":") + ":" + c.compositePath.join(":") === key,
      )
      if (index >= 0) collected[index] = record
      else collected.push(record)
    },
  })

  // 两个组合节点都在结果中
  assert.equal(result.composites.length, 2, "两个 sequence 各一个 composite")
  // 重名前提：兄弟 scope 的 cmpN 从 0 起
  const ids = result.composites.map((c) => c.id)
  assert.deepEqual(ids, ["cmp0", "cmp0"], "兄弟 scope 的 cmpN 重名")
  // scopePath 不同（这是区分依据）
  const scopePaths = result.composites.map((c) => c.scopePath.join(":"))
  assert.deepEqual(
    scopePaths.sort(),
    ["root:wf0", "root:wf1"],
    "scopePath 不同",
  )
  // 回调收集的两条都到达终态，不互相覆盖
  assert.equal(collected.length, 2, "回调不被重名覆盖")
  assert.ok(collected.every((c) => c.status === "ok"), "两条都到达 ok 终态")
})

test("嵌套组合节点：父子 composite 的 compositePath 不同不冲突", async () => {
  const dir = tmpProject()
  // 同一 scope 内嵌套两层 sequence
  const script =
    `export const meta = { name: 'nest' }\n` +
    `const r = await sequence([\n` +
    `  () => sequence([() => agent('inner-a'), () => agent('inner-b')]),\n` +
    `  () => agent('outer-b'),\n` +
    `])\n` +
    `return r`

  const collected: CompositeRecord[] = []
  const result = await runWorkflow(script, {
    agent: makeRunner(),
    cwd: dir,
    onCompositeUpdate: (record) => {
      const key = record.scopePath.join(":") + ":" + record.compositePath.join(":")
      const index = collected.findIndex(
        (c) => c.scopePath.join(":") + ":" + c.compositePath.join(":") === key,
      )
      if (index >= 0) collected[index] = record
      else collected.push(record)
    },
  })

  // 外层 cmp0 + 内层 cmp1（嵌套在同 scope 内）
  assert.equal(result.composites.length, 2, "外层 + 内层各一个")
  const outer = result.composites.find((c) => c.compositePath.length === 1)!
  const inner = result.composites.find((c) => c.compositePath.length === 2)!
  assert.ok(outer, "存在外层组合节点")
  assert.ok(inner, "存在内层组合节点")
  assert.deepEqual(outer.compositePath, ["cmp0"])
  assert.deepEqual(inner.compositePath, ["cmp0", "cmp1"], "内层 compositePath 含父链")
  assert.equal(collected.length, 2, "回调不互相覆盖")
})
