/**
 * checkpoint / verify 的 Composite 集成测试（Composite V1.1 P0-8/9/10/13）
 *
 * 覆盖：
 *  - checkpoint approve 在 sequence 中继续（SUCCESS）
 *  - checkpoint reject 强停止（红线4：不吃 fallback、不塌缩 parallel、后续节点不执行）
 *  - reject 的确定性 resume 回放（改 prompt 才会重问）
 *  - approve 的 resume 复用（不重复询问）
 *  - verify 作为组合节点（Execution != Business：real:false 仍是 success，脚本自己分支）
 *  - P0-13 组合模式：agent -> verify -> checkpoint -> 后续节点
 */

import test from "node:test"
import assert from "node:assert/strict"
import { runWorkflow, type WorkflowRunOptions } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

function makeRunner() {
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt) {
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 20)}`, sessionId: `s${prompts.length}`, type: "text" }
    },
  }
  return { runner, prompts }
}

const APPROVE = async () => true
const REJECT = async () => false

test("checkpoint approve：sequence 中SUCCESS继续，后续节点执行", async () => {
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'cp_approve' }
const gate = await sequence([
  () => agent('先做修改'),
  () => checkpoint('是否继续？'),
  () => agent('deploy 步骤'),
])
return { gate }`,
    { agent: runner, confirm: APPROVE },
  )
  assert.equal(prompts.length, 2, "deploy 节点执行")
  assert.match(String((result.result as any).gate), /^ok:deploy/, "sequence 返回末节点值（deploy 已执行）")
})

test("checkpoint reject：强停止——后续节点不执行，run 终止且错误码明确", async () => {
  const { runner, prompts } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'cp_reject' }
const seen = []
await sequence([
  () => { seen.push('modify'); return 'done' },
  () => checkpoint('是否发布？'),
  () => { seen.push('deploy'); return agent('deploy') },
])
return seen`,
      { agent: runner, confirm: REJECT },
    ),
    (error: any) => {
      assert.equal(error.code, "CHECKPOINT_REJECTED")
      assert.match(error.message, /人工拒绝/)
      return true
    },
  )
  assert.equal(prompts.length, 0, "deploy 的 agent 从未执行")
})

test("红线4：fallback 不吃 Human Reject——拒绝穿透，备用候选不执行", async () => {
  const { runner, prompts } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'cp_fb' }
const seen = []
await fallback([
  () => checkpoint('是否接受方案？'),
  () => { seen.push('alt'); return agent('备用方案') },
])
return seen`,
      { agent: runner, confirm: REJECT },
    ),
    (error: any) => error.code === "CHECKPOINT_REJECTED",
  )
  assert.equal(prompts.length, 0, "fallback 备用候选未被触发（拒绝不是普通 failure）")
})

test("红线4：parallel 内 reject 同样穿透，不塌缩 null", async () => {
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'cp_par' }
await parallel([
  () => checkpoint('闸门A'),
  () => agent('并行工作'),
])
return 'never'`,
      { agent: runner, confirm: REJECT },
    ),
    (error: any) => error.code === "CHECKPOINT_REJECTED",
  )
})

test("reject 后 resume：确定性重现拒绝（不重问）", async () => {
  const { runner } = makeRunner()
  const script = `export const meta = { name: 'cp_resume_reject' }
await agent('准备')
await checkpoint('是否发布？')
return await agent('deploy')`
  const journal = new Map<string, JournalEntry>()
  let confirmCalls = 0
  await assert.rejects(
    runWorkflow(script, {
      agent: runner,
      confirm: async () => {
        confirmCalls++
        return false
      },
      onAgentJournal: (e) => journal.set(e.key, e),
    }),
    (e: any) => e.code === "CHECKPOINT_REJECTED",
  )
  const firstRejects = confirmCalls
  // 同 runId 续跑：checkpoint 不重问（journal 回放），拒绝重现
  await assert.rejects(
    runWorkflow(script, {
      agent: runner,
      confirm: async () => {
        confirmCalls++
        return true // 即使这次人想同意，回放仍是拒绝（改 prompt 文本才会重问）
      },
      resumeJournal: journal,
      runId: [...journal.keys()][0]?.split(":")[0],
    }),
    (e: any) => e.code === "CHECKPOINT_REJECTED",
  )
  assert.equal(confirmCalls, firstRejects, "resume 没有重新弹确认")
})

test("approve 后 resume：复用授权，不重复询问且后续继续", async () => {
  const { runner, prompts } = makeRunner()
  const script = `export const meta = { name: 'cp_resume_ok' }
await sequence([
  () => checkpoint('是否继续？'),
  () => agent('deploy'),
])
return 'done'`
  const journal = new Map<string, JournalEntry>()
  let confirmCalls = 0
  await runWorkflow(script, {
    agent: runner,
    confirm: async () => {
      confirmCalls++
      return true
    },
    onAgentJournal: (e) => journal.set(e.key, e),
  })
  const runId = [...journal.keys()][0]?.split(":")[0]
  prompts.length = 0
  const r2 = await runWorkflow(script, {
    agent: runner,
    confirm: async () => {
      confirmCalls++
      return false
    },
    resumeJournal: journal,
    runId,
  })
  assert.equal(r2.result, "done")
  assert.equal(confirmCalls, 1, "续跑未重复询问")
  assert.equal(prompts.length, 0, "deploy agent 回放")
})

test("P0-8：verify 作为组合节点——real:false 是 success（Execution != Business），prev 直通", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'verify_node' }
const verdict = await sequence([
  () => agent('生成方案'),
  (prev) => verify(prev, { reviewers: 2 }),
  (v) => ({ real: v.real, total: v.total }),
])
return verdict`,
    { agent: runner },
  )
  const out = result.result as any
  assert.equal(out.total, 2, "verify 的两 reviewer 均执行")
  assert.equal(typeof out.real, "boolean", "业务判定字段直通，runtime 不改执行态")
})

test("P0-13 组合模式：agent -> verify -> checkpoint(approve) -> 后续节点 全链", async () => {
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'combo_gate' }
const fin = await sequence([
  () => agent('修改代码'),
  (prev) => verify(prev, { reviewers: 1 }),
  (v) => checkpoint('验证完成（real=' + v.real + '），是否发布？'),
  () => agent('publish'),
])
return { fin }`,
    { agent: runner, confirm: APPROVE },
  )
  assert.match(String((result.result as any).fin), /^ok:publish/, "末节点 publish 已执行")
  // 1 修改 + 1 reviewer + 1 publish
  assert.equal(prompts.filter((p) => p === "修改代码").length, 1, "verify prompt 内嵌前步输出，用精确匹配")
  assert.equal(prompts.filter((p) => p.includes("publish")).length, 1)
})

test("老写法兼容：脚本 try/catch 拒绝可优雅处理", async () => {
  const { runner } = makeRunner()
  const result = await runWorkflow(
    `export const meta = { name: 'cp_trycatch' }
let rejected = false
try {
  await checkpoint('是否执行？')
} catch (e) {
  rejected = String(e).includes('人工拒绝')
}
return { rejected, cancelled: rejected }`,
    { agent: runner, confirm: REJECT },
  )
  assert.equal(JSON.stringify(result.result), JSON.stringify({ rejected: true, cancelled: true }))
})
