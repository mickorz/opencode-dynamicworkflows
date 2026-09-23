/**
 * Node Execution Contract 单元测试（P0-2）
 * 覆盖：success（含 null/false/{ok:false} 值域）、可恢复 failure、cancelled、结构性错误上抛
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createNodeExecutor } from "../src/runtime/node-contract.js"
import { WorkflowError, WorkflowErrorCode } from "../src/runtime/errors.js"

const structural = (message: string) =>
  new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false })
const recoverable = (message: string) =>
  new WorkflowError(message, WorkflowErrorCode.AGENT_FAILED, { recoverable: true })

test("executeNode：resolve 任意值均为 success（null/false/0/空串/{ok:false} 不等于 failure）", async () => {
  const executeNode = createNodeExecutor(() => false)
  for (const value of [null, false, 0, "", { ok: false }, "text"]) {
    const r = await executeNode(() => value, undefined)
    assert.equal(r.status, "success")
    assert.equal(r.value, value)
  }
})

test("executeNode：可恢复 reject 映射为 failure", async () => {
  const executeNode = createNodeExecutor(() => false)
  const r = await executeNode(() => {
    throw recoverable("网络抖动")
  }, undefined)
  assert.equal(r.status, "failure")
  assert.ok(r.error instanceof WorkflowError)
})

test("executeNode：非 WorkflowError 的原生 throw 同样映射为 failure", async () => {
  const executeNode = createNodeExecutor(() => false)
  const r = await executeNode(() => {
    throw new TypeError("bad node")
  }, undefined)
  assert.equal(r.status, "failure")
})

test("executeNode：中止面上的可恢复 reject 映射为 cancelled", async () => {
  let aborted = false
  const executeNode = createNodeExecutor(() => aborted)
  const pending = executeNode(
    () =>
      new Promise((_resolve, reject) => {
        aborted = true
        reject(recoverable("workflow aborted"))
      }),
    undefined,
  )
  const r = await pending
  assert.equal(r.status, "cancelled")
})

test("executeNode：结构性错误（recoverable=false）原样上抛且不被包装", async () => {
  const executeNode = createNodeExecutor(() => false)
  const boom = structural("WORKFLOW_NOT_FOUND")
  await assert.rejects(
    executeNode(() => {
      throw boom
    }, undefined),
    (error: unknown) => error === boom,
  )
})

test("executeNode：input 作为 previous 传入节点", async () => {
  const executeNode = createNodeExecutor(() => false)
  const seen: unknown[] = []
  await executeNode((prev) => {
    seen.push(prev)
    return "next"
  }, { step: 1 })
  assert.deepEqual(seen, [{ step: 1 }])
})
