/**
 * Native workflow() 原语测试（P1）
 * 覆盖：串行/parallel child、args 克隆隔离、三身份（name/label/keySegment）、返回值直通、
 *       错误上抛、深度限制、自环拒绝、纯编排父合法、journal key 格式与 childSeq 稳定性、
 *       共享配额、共享 abort、limiter 死锁回归、resume 跨 scope、phase 前缀
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow, type WorkflowRunOptions } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"
import type { AgentRecord, JournalEntry, WorkflowRunResult } from "../src/types/index.js"

/** fake runner：记录调用并返回 prompt 的确定文本 */
function makeRunner() {
  const calls: Array<AgentRunOptions | undefined> = []
  const prompts: string[] = []
  const runner: AgentSessionRunner = {
    async run(prompt, options) {
      calls.push(options)
      prompts.push(prompt)
      return { value: `ok:${prompt.slice(0, 24)}`, sessionId: `sess-${prompts.length}`, type: "text" }
    },
  }
  return { runner, calls, prompts }
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-native-"))
}

function put(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, "utf-8")
  return file
}

/** 单 agent 子脚本模板 */
const CHILD = (name: string) =>
  `export const meta = { name: '${name}' }\nconst r = await agent('child task ' + (args?.tag ?? 'none'))\nreturn { from: '${name}', seen: args, reply: r }`

async function run(script: string, dir: string, extra: Partial<WorkflowRunOptions> = {}) {
  const { runner, prompts } = makeRunner()
  const result = await runWorkflow(script, { ...extra, agent: runner, cwd: dir })
  return { result, prompts }
}

test("串行 child：返回值直通、纯编排父合法、单 run 汇总", async () => {
  const dir = tmpProject()
  put(dir, "child_a.js", CHILD("child_a"))
  put(dir, "child_b.js", CHILD("child_b"))
  const parent = `export const meta = { name: 'parent' }
const a = await workflow('./child_a.js', { tag: 'A' })
const b = await workflow({ scriptPath: './child_b.js', label: '第二个' }, { tag: 'B' })
return { a: a.from, b: b.from, aSeen: a.seen.tag, bSeen: b.seen.tag }`
  const { result, prompts } = await run(parent, dir)
  assert.equal(JSON.stringify(result.result), JSON.stringify({ a: "child_a", b: "child_b", aSeen: "A", bSeen: "B" }), "VM realm 对象用 JSON 比较")
  assert.equal(result.agentCount, 2, "两个 child 各 1 agent")
  assert.equal(result.agents.length, 2, "单 run 汇总（无父子 run 分离）")
  assert.ok(prompts[0].includes("child task A"), "child args 透传到 agent prompt")
  assert.ok(prompts[1].includes("child task B"))
})

test("parallel child：三 child 并发、args 隔离、死锁回归（编排不占 slot）", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const parent = `export const meta = { name: 'cmp' }
const rs = await parallel([
  () => workflow({ scriptPath: './sub.js', label: 'deepseek' }, { tag: 'ds' }),
  () => workflow({ scriptPath: './sub.js', label: 'gpt' }, { tag: 'gpt' }),
  () => workflow({ scriptPath: './sub.js', label: 'claude' }, { tag: 'cl' }),
])
return rs.map(r => r.seen.tag).join(',')`
  // concurrency=1 是最严的死锁检验：若 workflow() 占 slot，三个编排调用互相等待永不完成
  const { result, prompts } = await run(parent, dir, { concurrency: 1 })
  assert.equal((result.result as string).split(",").sort().join(","), "cl,ds,gpt")
  assert.equal(result.agentCount, 3)
  const tags = prompts.map((p) => /child task (\w+)$/.exec(p)?.[1]).sort()
  assert.deepEqual(tags, ["cl", "ds", "gpt"])
})

test("args 结构化克隆：child 内 mutation 不外溢到 parent 对象", async () => {
  const dir = tmpProject()
  put(dir, "mut.js", `export const meta = { name: 'mut' }
args.options.temperature = 99
args.newKey = 'polluted'
return await agent('x')`)
  const shared: { options: { temperature: number }; newKey?: string } = { options: { temperature: 1 } }
  const parent = `export const meta = { name: 'p' }
const cfg = args.cfg
await workflow('./mut.js', cfg)
return { temp: cfg.options.temperature, hasNew: 'newKey' in cfg }`
  const { result } = await run(parent, dir, { args: { cfg: shared } })
  const ret = result.result as { temp: number; hasNew: boolean }
  assert.equal(ret.temp, 1, "child 内改 args 不影响父对象")
  assert.equal(ret.hasNew, false, "child 新增 key 不外溢")
  assert.equal(shared.options.temperature, 1, "原始传入对象同样不受影响")
})

test("三身份：同名 child 不同 label，phase 前缀与 agent 记录区分", async () => {
  const dir = tmpProject()
  put(dir, "same.js", `export const meta = { name: 'same_def' }\nphase('干活')\nreturn await agent('task')`)
  const parent = `export const meta = { name: 'p' }
phase('总控')
return (await parallel([
  () => workflow({ scriptPath: './same.js', label: 'ds' }),
  () => workflow({ scriptPath: './same.js', label: 'gpt' }),
])).length`
  const { result } = await run(parent, dir)
  const phases = result.agents.map((a) => a.phase).sort()
  assert.deepEqual(phases, ["▸ ds / 干活", "▸ gpt / 干活"], "phase 用 label 前缀区分同定义实例")
  assert.ok(result.phases.includes("总控"))
  assert.ok(result.phases.includes("▸ ds / 干活"))
})

test("错误上抛：child 脚本 throw 时父收到异常（不塌缩 null）", async () => {
  const dir = tmpProject()
  put(dir, "boom.js", `export const meta = { name: 'boom' }\nthrow new Error('child 业务失败')`)
  const parent = `export const meta = { name: 'p' }\nawait workflow('./boom.js')\nreturn 'never'`
  await assert.rejects(run(parent, dir), /child 业务失败/)
})

test("child 返回 {ok:false} 不影响 runtime 完成（业务字段与执行态分离）", async () => {
  const dir = tmpProject()
  put(dir, "gate.js", `export const meta = { name: 'gate' }\nawait agent('check')\nreturn { ok: false, reason: '产物闸门未过' }`)
  const parent = `export const meta = { name: 'p' }\nconst r = await workflow('./gate.js')\nreturn r`
  const { result } = await run(parent, dir)
  assert.deepEqual(result.result, { ok: false, reason: "产物闸门未过" }, "返回值直通，runtime 正常 success")
})

test("深度限制：child 内再调 workflow() 报超限", async () => {
  const dir = tmpProject()
  put(dir, "inner.js", `export const meta = { name: 'inner' }\nreturn await workflow('./inner2.js')`)
  put(dir, "inner2.js", CHILD("inner2"))
  const parent = `export const meta = { name: 'p' }\nawait workflow('./inner.js')`
  await assert.rejects(run(parent, dir), /嵌套深度超限/)
})

test("自环拒绝：child 调用自身脚本（大小写变体也被归一拦下）", async () => {
  const dir = tmpProject()
  // root 是内联脚本无路径；真正的自环 = child 文件内两用大小写变体调用自己
  put(dir, "self.js", `export const meta = { name: 'self' }\nawait agent('first')\nreturn await workflow('./SELF.js')`)
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('./self.js')`
  await assert.rejects(run(parent, dir), /不能调用自身或祖先/)
})

test("journal key：root 旧格式兼容、child 为 runId wfN callIndex、childSeq 不随前置 agent 漂移", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const parent = `export const meta = { name: 'p' }
await agent('前置调用')
const r = await workflow('./sub.js')
return r.reply`
  const entries: Array<JournalEntry & { key: string }> = []
  const { runner } = makeRunner()
  const result = await runWorkflow(parent, {
    agent: runner,
    cwd: dir,
    runId: "run-xyz",
    onAgentJournal: (e) => entries.push(e),
  })
  const keys = entries.map((e) => e.key)
  assert.deepEqual(keys, ["run-xyz:0", "run-xyz:wf0:0"], "root 保持旧格式；前置 agent 不漂移 child 编号（仍 wf0）")
  assert.equal(result.agentCount, 2)
  assert.equal(result.agents[0].id, "run-xyz:0")
  assert.equal(result.agents[1].id, "run-xyz:wf0:0")
})

test("共享配额：maxAgents 打满时 child 内 dispatch 报错", async () => {
  const dir = tmpProject()
  put(dir, "two.js", `export const meta = { name: 'two' }\nconst a = await agent('one')\nconst b = await agent('two')\nreturn a`)
  const parent = `export const meta = { name: 'p' }\nawait agent('root 占用')\nreturn await workflow('./two.js')`
  await assert.rejects(
    run(parent, dir, { maxAgents: 2 }),
    /agent 数量超限/,
    "root 1 个 + child 内第 2 个即触顶（共享配额）",
  )
})

test("共享 abort：父 signal 中止时 child 内 agent 一并中止", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const controller = new AbortController()
  const { runner } = makeRunner()
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('./sub.js')`
  // agent 启动即 abort（确定性时序：不依赖 fake runner 的同步完成速度）
  let abortedOnce = false
  await assert.rejects(
    runWorkflow(parent, {
      agent: runner,
      cwd: dir,
      signal: controller.signal,
      onAgentUpdate: (r) => {
        if (!abortedOnce && r.status === "running") {
          abortedOnce = true
          controller.abort()
        }
      },
    }),
    /abort/i,
  )
})

test("resume 跨 scope：child 的 agent journal 命中回放（不调 LLM）", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const parent = `export const meta = { name: 'p' }\nconst r = await workflow('./sub.js', { tag: 'T' })\nreturn r.reply`

  // 第一轮：收集 journal
  const journal = new Map<string, JournalEntry>()
  {
    const { runner } = makeRunner()
    await runWorkflow(parent, { agent: runner, cwd: dir, runId: "run-r", onAgentJournal: (e) => journal.set(e.key, e as JournalEntry) })
  }
  // 第二轮：同 runId + resumeJournal，child 的 agent 应回放（runner 零调用）
  {
    const { runner, prompts } = makeRunner()
    const result = await runWorkflow(parent, {
      agent: runner,
      cwd: dir,
      runId: "run-r",
      resumeJournal: journal,
    })
    assert.equal(prompts.length, 0, "child 的 agent 从 journal 回放，不再 dispatch")
    assert.match(String(result.result), /ok:/, "回放结果直通到父返回值")
    assert.equal(result.agents[0].replayed, true)
  }
})

test("纯编排父合法（root 级 agentCount）：父零 agent 仅经 child dispatch", async () => {
  const dir = tmpProject()
  put(dir, "only.js", CHILD("only"))
  const parent = `export const meta = { name: 'orchestrator' }\nreturn await workflow('./only.js')`
  const { result } = await run(parent, dir)
  assert.equal(result.agentCount, 1)
  assert.match(String((result.result as { reply: string }).reply), /ok:/)
})

test("纯计算且零 dispatch 的脚本仍被拒（root 级校验不放松语义）", async () => {
  const dir = tmpProject()
  const parent = `export const meta = { name: 'pure' }\nreturn 1 + 1`
  await assert.rejects(run(parent, dir), /至少调用一次 agent/)
})

test("child 脚本缺失：明确报路径错误", async () => {
  const dir = tmpProject()
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('./ghost.js')`
  await assert.rejects(run(parent, dir), /子脚本不存在或不可读/)
})

test("args 非 clone 兼容（含函数）：明确报边界约束", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const parent = `export const meta = { name: 'p' }\nreturn await workflow('./sub.js', { fn: () => 1 })`
  await assert.rejects(run(parent, dir), /structured-clone-compatible/)
})

test("死锁回归：concurrency=1 下 parallel 两 child 各 1 agent 必须完成", async () => {
  const dir = tmpProject()
  put(dir, "sub.js", CHILD("sub"))
  const parent = `export const meta = { name: 'dl' }\nconst rs = await parallel([\n  () => workflow('./sub.js', { tag: 1 }),\n  () => workflow('./sub.js', { tag: 2 }),\n])\nreturn rs.length`
  // 超时保护交给 node:test 默认；若 workflow() 误占 slot 此处会挂死
  const { result } = await run(parent, dir, { concurrency: 1 })
  assert.equal(result.result, 2)
  assert.equal(result.agentCount, 2)
})
