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

// ── P0-4：sequence + child workflow 集成 ──

test("sequence 串三个 child workflow：args 传递 + structuredClone 双向隔离", async () => {
  const dir = tmpProject()
  put(dir, "a.js", `export const meta = { name: 'a' }
const r = await agent('step a')
return { from: 'a', payload: args }`)
  put(dir, "b.js", `export const meta = { name: 'b' }
// 尝试 mutation 父传入的 args（不应外溢到 sequence 的 prev 或父脚本）
args.payload.mutatedByChild = true
return { from: 'b', received: args.payload }`)
  put(dir, "c.js", `export const meta = { name: 'c' }
return { from: 'c', received: args.received }`)
  const { result } = await run(
    `export const meta = { name: 'seq_wf' }
const shared = { payload: { step: 1 } }
const r = await sequence([
  () => workflow('./a.js', shared),
  (a) => workflow('./b.js', a),
  (b) => workflow('./c.js', b),
])
return { r, sharedAfter: shared }`,
    dir,
  )
  const out = result.result as any
  assert.equal(out.r.from, "c")
  // child b 内的 mutation 不外溢：sequence 的 prev 与父脚本的 shared 都未被污染
  assert.equal(out.r.received.mutatedByChild, true, "child 内能改自己的克隆副本")
  assert.equal((out.sharedAfter as any).payload.mutatedByChild, undefined, "父脚本对象不被 child 污染")
})

test("sequence 返回值经 structuredClone：child 结果对象与 VM 内引用不共享", async () => {
  const dir = tmpProject()
  put(dir, "a.js", `export const meta = { name: 'a' }
await agent('x')
return { nested: { value: 1 } }`)
  const { result } = await run(
    `export const meta = { name: 'seq_clone' }
const r = await sequence([() => workflow('./a.js')])
r.nested.value = 999
return { mutated: r.nested.value }`,
    dir,
  )
  // 父脚本对返回值的修改只是自己的副本，不回写 child 结果（此处仅验证可自由修改不炸）
  assert.equal((result.result as any).mutated, 999)
})

test("sequence 节点内组合 parallel：多 child 并发 + 结果保持输入顺序", async () => {
  const dir = tmpProject()
  put(dir, "x.js", `export const meta = { name: 'x' }\nreturn await agent('child ' + args.tag)`)
  const { result } = await run(
    `export const meta = { name: 'seq_par' }
const r = await sequence([
  () => 'begin',
  (prev) => parallel([
    () => workflow('./x.js', { tag: prev + '-1' }),
    () => workflow('./x.js', { tag: prev + '-2' }),
  ]),
  (results) => results.map(r => r.split(':').pop()).join(','),
])
return r`,
    dir,
  )
  assert.equal(result.result, "child begin-1,child begin-2")
})

test("sequence 内 child 的自环与深度检查照常生效", async () => {
  const dir = tmpProject()
  put(dir, "self.js", `export const meta = { name: 'self' }\nreturn await workflow('./self.js')`)
  await assert.rejects(
    run(
      `export const meta = { name: 'seq_cycle' }
await sequence([() => workflow('./self.js')])
return 'never'`,
      dir,
    ),
    /不能调用自身或祖先/,
  )
})

test("sequence 与 child 共享 maxAgents 配额", async () => {
  const dir = tmpProject()
  put(dir, "c.js", `export const meta = { name: 'c' }\nreturn await agent('inner')`)
  const { runner } = makeRunner()
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'seq_quota' }
await sequence([
  () => workflow('./c.js'),
  () => workflow('./c.js'),
  () => workflow('./c.js'),
])
return 'never'`,
      { agent: runner, cwd: dir, maxAgents: 2 },
    ),
    /agent 数量超限/,
  )
})

test("sequence 内 child 的 agent 保留 workflowPath 双身份（observability 不变）", async () => {
  const dir = tmpProject()
  put(dir, "c.js", `export const meta = { name: 'c' }\nreturn await agent('inner task')`)
  const { result } = await run(
    `export const meta = { name: 'seq_obs' }
await sequence([
  () => workflow('./c.js'),
  () => workflow('./c.js'),
])
return 'done'`,
    dir,
  )
  const childAgents = result.agents.filter((a) => a.workflowPath)
  assert.equal(childAgents.length, 2, "sequence 不改变 child agent 的双身份字段")
  assert.deepEqual(childAgents[0].workflowScopePath, ["root", "wf0"])
  assert.deepEqual(childAgents[1].workflowScopePath, ["root", "wf1"])
})

test("父 run abort 终止 sequence 内正在执行的 child", async () => {
  const dir = tmpProject()
  put(dir, "slow.js", `export const meta = { name: 'slow' }\nreturn await agent('slow work')`)
  const controller = new AbortController()
  const runner: AgentSessionRunner = {
    async run(prompt) {
      if (prompt.includes("trigger")) controller.abort()
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'seq_abort_child' }
await sequence([
  () => agent('trigger abort'),
  () => workflow('./slow.js'),
])
return 'never'`,
      { agent: runner, cwd: dir, signal: controller.signal },
    ),
    /abort/i,
  )
})

// ── P0-5：journal / resume 兼容（sequence 对 journal 透明） ──

/** 单次运行并采集 journal */
async function runOnce(script: string, dir: string) {
  const journal = new Map<string, JournalEntry>()
  const runner: AgentSessionRunner = {
    async run(prompt) {
      return { value: `ok:${prompt}`, sessionId: "s", type: "text" }
    },
  }
  const result = await runWorkflow(script, {
    agent: runner,
    cwd: dir,
    onAgentJournal: (entry) => journal.set(entry.key, entry),
  })
  return { result, journal }
}

test("sequence 不占 journal callIndex：key 形态与裸 await 完全一致", async () => {
  const dir = tmpProject()
  const { result, journal } = await runOnce(
    `export const meta = { name: 'seq_journal' }
await sequence([
  () => agent('A'),
  () => agent('B'),
])
await agent('C')
return 'done'`,
    dir,
  )
  assert.deepEqual(
    [...journal.keys()],
    [`${result.runId}:0`, `${result.runId}:1`, `${result.runId}:2`],
    "sequence 自身不产生 journal 记录，agent 按位置连续编号",
  )
})

test("sequence 内 agent 与 checkpoint 全量 resume 回放", async () => {
  const dir = tmpProject()
  const script = `export const meta = { name: 'seq_resume' }
const a = await sequence([
  () => agent('first'),
  (prev) => agent('second ' + prev.slice(0, 4)),
])
const gate = await checkpoint('人工闸门')
return { a, gate }`
  const { result, journal } = await runOnce(script, dir)
  assert.equal(journal.size, 3, "2 个 agent + 1 个 checkpoint")

  // 同 runId 续跑：全部回放，不触发真实调用
  const calls: string[] = []
  const confirms: string[] = []
  const resumed = await runWorkflow(script, {
    agent: {
      async run(prompt) {
        calls.push(prompt)
        return { value: "should-not-run", sessionId: "s", type: "text" }
      },
    },
    confirm: async (p) => {
      confirms.push(p)
      return "confirmed"
    },
    runId: result.runId,
    resumeJournal: journal,
    cwd: dir,
  })
  assert.equal(calls.length, 0, "sequence 内 agent 全部回放")
  assert.equal(confirms.length, 0, "sequence 后的 checkpoint 同样回放")
  assert.deepEqual(
    (resumed.result as any).a,
    (result.result as any).a,
    "回放结果与首跑一致（prev 传递链路在回放下不变）",
  )
})

test("sequence 内 child workflow 的 journal key 仍为 wfK 寻址", async () => {
  const dir = tmpProject()
  put(dir, "c.js", `export const meta = { name: 'c' }\nreturn await agent('inner')`)
  const { result, journal } = await runOnce(
    `export const meta = { name: 'seq_wf_journal' }
await sequence([
  () => workflow('./c.js'),
  () => workflow('./c.js'),
])
return 'done'`,
    dir,
  )
  assert.deepEqual(
    [...journal.keys()],
    [`${result.runId}:wf0:0`, `${result.runId}:wf1:0`],
    "child agent 的 journal key 不受 sequence 影响",
  )
})

// ── P0-6：fallback ──

test("fallback：首个成功候选返回，后续候选不执行", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'fb_first' }
const seen = []
const r = await fallback([
  () => { seen.push('a'); throw new Error('fast 不可用') },
  () => { seen.push('b'); return 'strong-result' },
  () => { seen.push('c'); return 'never' },
])
await agent('bookkeeping')
return { r, seen: seen.join('|') }`,
    dir,
  )
  assert.equal((result.result as any).r, "strong-result")
  assert.equal((result.result as any).seen, "a|b")
  assert.ok(result.logs.some((l: string) => l.includes("fallback[0] 失败")))
})

test("fallback：全部候选可恢复失败时返回 null", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'fb_all_fail' }
const r = await fallback([
  () => { throw new Error('A 失败') },
  () => { throw new Error('B 失败') },
])
await agent('bookkeeping')
return { r, isNull: r === null }`,
    dir,
  )
  assert.equal((result.result as any).r, null)
  assert.equal((result.result as any).isNull, true)
  assert.ok(result.logs.some((l: string) => l.includes("fallback 全部候选失败")))
})

test("fallback：首个候选直接成功则后续完全跳过", async () => {
  const dir = tmpProject()
  const { result, calls } = await run(
    `export const meta = { name: 'fb_skip' }
const r = await fallback([
  () => 'fast-ok',
  () => agent('strong-model'),
])
await agent('bookkeeping')
return r`,
    dir,
  )
  assert.equal(result.result, "fast-ok")
  assert.equal(calls.filter((c) => c && (c as AgentRunOptions).label === "strong-model").length, 0, "后续候选未执行")
  assert.equal(calls.length, 1, "仅 bookkeeping")
})

test("fallback：结构性错误必须上抛，不能被伪装成降级", async () => {
  const dir = tmpProject()
  // 未知 workflow 名是结构性错误（脚本拼错），fallback 不允许吞掉
  await assert.rejects(
    run(
      `export const meta = { name: 'fb_structural' }
const r = await fallback([
  () => workflow('./不存在的脚本.js'),
  () => workflow('./backup.js'),
])
return r`,
      dir,
    ),
    /不存在或不可读/,
  )
})

test("fallback：候选可组合 workflow，成功的 child 结果直通", async () => {
  const dir = tmpProject()
  put(dir, "fast.js", `export const meta = { name: 'fast' }\nawait agent('fast try')\nthrow new Error('fast 质量不足')`)
  put(dir, "strong.js", `export const meta = { name: 'strong' }\nconst r = await agent('strong run')\nreturn { model: 'strong', r }`)
  const { result } = await run(
    `export const meta = { name: 'fb_wf' }
const r = await fallback([
  () => workflow('./fast.js'),
  () => workflow('./strong.js'),
])
return r`,
    dir,
  )
  assert.equal((result.result as any).model, "strong")
})

test("fallback 与 sequence 可互相嵌套组合", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'fb_nested' }
const r = await sequence([
  () => 'start',
  (prev) => fallback([
    () => { throw new Error('路径甲失败') },
    () => prev + '-via-b',
  ]),
])
await agent('bookkeeping')
return r`,
    dir,
  )
  assert.equal(result.result, "start-via-b")
})

test("fallback：中止面上候选 reject 时上抛 WORKFLOW_ABORTED（不换下一候选）", async () => {
  const dir = tmpProject()
  const controller = new AbortController()
  const runner: AgentSessionRunner = {
    async run(prompt) {
      if (prompt.includes("trigger")) controller.abort()
      return { value: "ok", sessionId: "s", type: "text" }
    },
  }
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'fb_abort' }
const r = await sequence([
  () => agent('trigger abort'),
  () => fallback([
    () => { throw new Error('中止后的拒绝') },
    () => 'never',
  ]),
])
return r`,
      { agent: runner, cwd: dir, signal: controller.signal },
    ),
    /abort/i,
  )
})

// ── P0-7：旧写法与 sequence 重写的等价性 ──

test("等价性：旧 await 链与 sequence 重写产出一致的执行面（结果/agent 数/child 数/日志 journal）", async () => {
  const dir = tmpProject()
  put(dir, "a.js", `export const meta = { name: 'a' }\nreturn { from: 'a', reply: await agent('step a') }`)
  put(dir, "b.js", `export const meta = { name: 'b' }\nreturn { from: 'b', prev: args.from }`)
  const scriptOld = `export const meta = { name: 'equiv_old' }
const a = await workflow('./a.js')
const b = await workflow('./b.js', { from: a.from })
const check = await agent('verify ' + b.from)
return { b, check }`
  const scriptSeq = `export const meta = { name: 'equiv_seq' }
const b = await sequence([
  () => workflow('./a.js'),
  (a) => workflow('./b.js', { from: a.from }),
])
const check = await agent('verify ' + b.from)
return { b, check }`

  const collect = async (script: string) => {
    const journal = new Map<string, JournalEntry>()
    const tokens: number[] = []
    const runner: AgentSessionRunner = {
      async run(prompt) {
        tokens.push(10)
        return { value: `ok:${prompt}`, sessionId: "s", type: "text" }
      },
    }
    const result = await runWorkflow(script, {
      agent: runner,
      cwd: dir,
      onAgentJournal: (e) => journal.set(e.key, e),
    })
    return { result, journal, tokenTotal: tokens.length * 10 }
  }
  const old = await collect(scriptOld)
  const seq = await collect(scriptSeq)

  // 执行结果一致（sequence 返回最后节点值，等价于旧链的 b）
  assert.deepEqual((seq.result.result as any).b, (old.result.result as any).b)
  assert.equal((seq.result.result as any).check, (old.result.result as any).check)
  // agent 数 / workflow 数 / token 计数一致
  assert.equal(seq.result.agentCount, old.result.agentCount)
  assert.equal(seq.result.workflows.length, old.result.workflows.length)
  assert.equal(seq.journal.size, old.journal.size)
  assert.equal(seq.tokenTotal, old.tokenTotal)
  // journal key 形态一致（sequence 未引入额外 key；runId 前缀因两次独立 run 必然不同，剥掉比较）
  const shape = (keys: string[]) => keys.map((k) => k.replace(/^[^:]+:/, "")).sort()
  assert.deepEqual(shape([...seq.journal.keys()]), shape([...old.journal.keys()]))
  // sequence 版本同样可 resume：全量回放
  const replayCalls: string[] = []
  await runWorkflow(scriptSeq, {
    agent: {
      async run(prompt) {
        replayCalls.push(prompt)
        return { value: "x", sessionId: "s", type: "text" }
      },
    },
    cwd: dir,
    runId: seq.result.runId,
    resumeJournal: seq.journal,
  })
  assert.equal(replayCalls.length, 0, "sequence 版本全量回放")
})

test("child 脚本 throw 在 parallel 内塌缩为 null（poisoning 修正后的文档语义）", async () => {
  const dir = tmpProject()
  put(dir, "boom.js", `export const meta = { name: 'boom' }\nthrow new Error('child 业务失败')`)
  put(dir, "fine.js", `export const meta = { name: 'fine' }\nreturn await agent('fine task')`)
  const { result } = await run(
    `export const meta = { name: 'par_child_fail' }
const rs = await parallel([
  () => workflow('./boom.js'),
  () => workflow('./fine.js'),
])
return { rs, len: rs.length }`,
    dir,
  )
  const out = result.result as any
  assert.equal(out.len, 2)
  assert.equal(out.rs[0], null, "recoverable child 失败塌缩为 null")
  assert.match(out.rs[1], /^ok:fine/, "兄弟分支不受影响")
})

test("child 脚本 throw 后父脚本 try-catch 可继续执行（中止面不再污染）", async () => {
  const dir = tmpProject()
  put(dir, "boom.js", `export const meta = { name: 'boom' }\nthrow new Error('child 业务失败')`)
  const { result } = await run(
    `export const meta = { name: 'try_catch_child' }
let err = null
try { await workflow('./boom.js') } catch (e) { err = String(e) }
const after = await agent('after failure')
return { err, after }`,
    dir,
  )
  const out = result.result as any
  assert.match(out.err, /child 业务失败/)
  assert.match(out.after, /^ok:after/)
})

// ── P1-1：parallel 纳入 Node 模型（组合完备性钉死） ──

test("组合完备：fallback 候选为 parallel，sequence 包裹 fallback（三种 composite 互嵌）", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'nest_all' }
const r = await sequence([
  () => 'seed',
  (seed) => fallback([
    () => { throw new Error('直接候选失败') },
    () => parallel([
      () => seed + '-lane1',
      () => { throw new Error('lane2 失败塌缩 null') },
    ]),
  ]),
  (prev) => prev.filter(x => x !== null).join('+'),
])
await agent('bookkeeping')
return r`,
    dir,
  )
  // parallel 保序 + 失败槽位 null：[seed-lane1, null] -> filter -> join
  assert.equal(result.result, "seed-lane1")
})

test("组合完备：parallel 分支内各自跑独立 sequence", async () => {
  const dir = tmpProject()
  const { result } = await run(
    `export const meta = { name: 'par_seq' }
const rs = await parallel([
  () => sequence([() => 'a1', (p) => p + '-a2']),
  () => sequence([() => 'b1', (p) => p + '-b2']),
])
await agent('bookkeeping')
return rs.join('|')`,
    dir,
  )
  assert.equal(result.result, "a1-a2|b1-b2")
})
