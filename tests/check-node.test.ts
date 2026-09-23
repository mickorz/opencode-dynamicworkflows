/**
 * check() 确定性验证节点测试（P1-1）
 * 覆盖：true=SUCCESS 传递、false=可恢复 FAILURE（sequence 停止/fallback 换候选/parallel 塌缩）、
 *       condition throw=结构性错误、与 verify/checkpoint 的职责边界、组合模式
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"

function makeRunner() {
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 16)}`, sessionId: "s", type: "text" }
    },
  }
  return { runner, prompts }
}

test("check true：返回 true 且作为 prev 传给下一节点", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'check_true' }
const r = await sequence([
  () => agent('生成文件'),
  () => check(() => true, '文件应存在'),
  (prev) => ({ gate: prev, tail: 'ran' }),
])
return r`,
    { agent: runner },
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { gate: true, tail: "ran" })
})

test("check false：sequence 停止返回 null，后续节点不执行", async () => {
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'check_false' }
const seen = []
const r = await sequence([
  () => { seen.push('work'); return 'did' },
  () => check(() => false, '产物未落盘'),
  () => { seen.push('never'); return agent('下一步') },
])
await agent('bookkeeping')
return { r, isNull: r === null, seen: seen.join('|') }`,
    { agent: runner },
  )
  const out = JSON.parse(JSON.stringify(result.result))
  assert.equal(out.isNull, true)
  assert.equal(out.seen, "work")
  assert.equal(prompts.filter((p) => p.includes("bookkeeping")).length, 1)
})

test("check false：fallback 视为普通可恢复失败换下一候选", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'check_fb' }
const r = await fallback([
  () => check(() => false, '快路径产物校验未过'),
  () => agent('慢速可靠路径'),
])
return r`,
    { agent: runner },
  )
  assert.match(String(result.result), /^ok:慢速可靠路径/)
})

test("check false：parallel 内塌缩 null", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'check_par' }
const rs = await parallel([
  () => check(() => false, '甲失败'),
  () => check(() => true, '乙过'),
])
await agent('bookkeeping')
return rs.map(x => x === null ? 'null' : x).join('|')`,
    { agent: runner },
  )
  assert.equal(result.result, "null|true")
})

test("condition throw：结构性错误不被 fallback 吞掉", async () => {
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'check_throw' }
await fallback([
  () => check(() => { throw new Error('读文件炸了') }, 'x'),
  () => ({ via: 'backup' }),
])
return 'never'`,
      { agent: runner },
    ),
    (e: any) => {
      assert.equal(e.code, "SCRIPT_VALIDATION_ERROR")
      assert.match(e.message, /检查代码出错|条件执行出错/)
      return true
    },
  )
})

test("组合模式：agent -> check -> agent（确定性闸门）", async () => {
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'check_combo' }
const r = await sequence([
  () => agent('写配置'),
  () => check(() => true, '配置校验'),
  (prev) => agent('基于 ' + String(prev) + ' 继续'),
])
return r`,
    { agent: runner },
  )
  assert.equal(prompts.length, 2)
  assert.match(String(result.result), /^ok:基于 true/)
})

test("非函数入参：结构性报错", async () => {
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'check_invalid' }
await check(true)
return 'never'`,
      { agent: runner },
    ),
    /需要函数条件/,
  )
})
