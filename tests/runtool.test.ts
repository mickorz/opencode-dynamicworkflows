/**
 * P4.1-B runTool 原语单元测试
 *
 * 覆盖执行文档第三节测试清单：
 *  - 成功返回结构 / 缺省失败抛 TOOL_FAILED（可恢复）/ onFailure return
 *  - fallback 换候选 / sequence 停止 / retry
 *  - parseJson / 纯 runTool 合法 / 纯计算仍拒
 *  - 边界：项目外 / 不存在 / 非白名单 / symlink 逃逸 / 超时
 *  - journal executions 记录（无 hash，resume 必 miss）
 *  - resume 下游失效：runTool 输出变化 -> 下游 agent prompt 变 -> 重跑
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import { WorkflowError, WorkflowErrorCode } from "../src/runtime/errors.js"
import { JournalStore } from "../src/persistence/journal.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { JournalEntry } from "../src/types/index.js"

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p41-runtool-"))
    try {
      await fn(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** fake agent runner：记录 prompt，返回固定文本（协议与现有测试一致） */
function fakeAgent(prompts: string[]): AgentSessionRunner {
  return {
    run: async (prompt: string) => {
      prompts.push(prompt)
      return { type: "text", value: `echo:${prompt.slice(0, 60)}`, sessionId: `s${prompts.length}` }
    },
  }
}

const META = `export const meta = { name: 'rt_test', description: 'runTool 测试' }\n`

/** .py 脚本 fixture（输出 JSON） */
function writePyTool(dir: string, output: string): string {
  const p = path.join(dir, "tools", "probe.py")
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, `import json\nprint(json.dumps(${output}))\n`, "utf8")
  return p
}

// ============================================================
// 基础：返回结构 / 失败语义
// ============================================================

test("runTool：成功返回结构齐全，parseJson 填 parsed", async () => {
  await withTempDir(async (dir) => {
    writePyTool(dir, "{'status': 'ok', 'count': 3}")
    const r = await runWorkflow(
      META + `
const result = await runTool("tools/probe.py", { parseJson: true })
return result
`,
      { agent: fakeAgent([]), cwd: dir, runId: "run-rt-1" },
    )
    const v = r.result as { ok: boolean; exitCode: number; parsed?: { status: string; count: number } }
    assert.equal(v.ok, true)
    assert.equal(v.exitCode, 0)
    assert.equal(v.parsed?.status, "ok")
    assert.equal(v.parsed?.count, 3)
    assert.equal(r.toolCount, 1)
    assert.equal(r.agentCount, 0, "runTool 不计 agent 配额")
  })()
})

test("runTool：缺省失败抛 TOOL_FAILED（可恢复），消息含 exitCode", async () => {
  await withTempDir(async (dir) => {
    const p = path.join(dir, "tools", "fail.py")
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, `import sys\nprint("boom-detail", file=sys.stderr)\nsys.exit(2)\n`, "utf8")
    await assert.rejects(
      runWorkflow(
        META + `await runTool("tools/fail.py")\nreturn "unreachable"\n`,
        { agent: fakeAgent([]), cwd: dir, runId: "run-rt-2" },
      ),
      (e: unknown) =>
        e instanceof WorkflowError &&
        e.code === WorkflowErrorCode.TOOL_FAILED &&
        e.recoverable === true &&
        /exit 2/.test(e.message) &&
        /boom-detail/.test(e.message),
    )
  })()
})

test("runTool：onFailure return 模式返回失败对象不抛错", async () => {
  await withTempDir(async (dir) => {
    const p = path.join(dir, "tools", "fail.py")
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, `import sys\nsys.exit(3)\n`, "utf8")
    const r = await runWorkflow(
      META + `
const result = await runTool("tools/fail.py", { onFailure: "return" })
return { ok: result.ok, exitCode: result.exitCode, hasStderr: typeof result.stderr }
`,
      { agent: fakeAgent([]), cwd: dir, runId: "run-rt-3" },
    )
    const v = r.result as { ok: boolean; exitCode: number; hasStderr: string }
    assert.equal(v.ok, false)
    assert.equal(v.exitCode, 3)
    assert.equal(v.hasStderr, "string")
  })()
})

// ============================================================
// 组合控制流感知
// ============================================================

test("runTool：fallback 换候选（第一候选工具失败，第二候选执行）", async () => {
  await withTempDir(async (dir) => {
    const bad = path.join(dir, "tools", "bad.py")
    const good = path.join(dir, "tools", "good.py")
    mkdirSync(path.dirname(bad), { recursive: true })
    writeFileSync(bad, `import sys\nsys.exit(1)\n`, "utf8")
    writeFileSync(good, `print("from-good")\n`, "utf8")
    const r = await runWorkflow(
      META + `
const outcome = await fallback([
  () => runTool("tools/bad.py"),
  () => runTool("tools/good.py"),
])
return outcome
`,
      { agent: fakeAgent([]), cwd: dir, runId: "run-rt-4" },
    )
    assert.equal((r.result as { stdout: string }).stdout.trim(), "from-good")
    assert.equal(r.toolCount, 2)
  })()
})

test("runTool：sequence 中失败即停止（后续节点不执行）", async () => {
  await withTempDir(async (dir) => {
    const bad = path.join(dir, "tools", "bad.py")
    mkdirSync(path.dirname(bad), { recursive: true })
    writeFileSync(bad, `import sys\nsys.exit(1)\n`, "utf8")
    const prompts: string[] = []
    await assert.rejects(
      runWorkflow(
        META + `
const step1 = await runTool("tools/bad.py")
phase("后续")
const agentResult = await agent("不应被执行的节点")
return { step1, agentResult }
`,
        { agent: fakeAgent(prompts), cwd: dir, runId: "run-rt-5" },
      ),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.TOOL_FAILED,
    )
    assert.equal(prompts.length, 0, "TOOL_FAILED 抛错后后续 agent 不得执行")
  })()
})

// ============================================================
// 有效性判定
// ============================================================

test("纯 runTool Workflow 合法（零 Agent 零 token）", async () => {
  await withTempDir(async (dir) => {
    writePyTool(dir, "{'status': 'ok'}")
    const r = await runWorkflow(
      META + `
phase("确定性执行")
const a = await runTool("tools/probe.py", { parseJson: true })
const b = await runTool("tools/probe.py")
return { first: a.parsed, secondOk: b.ok }
`,
      { agent: fakeAgent([]), cwd: dir, runId: "run-rt-6" },
    )
    assert.equal(r.agentCount, 0)
    assert.equal(r.toolCount, 2)
    assert.equal((r.result as { first: { status: string } }).first.status, "ok")
  })()
})

test("纯计算 Workflow（无 agent 无 runTool）仍被拒", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      runWorkflow(
        META + `const x = 1 + 1\nreturn x\n`,
        { agent: fakeAgent([]), cwd: dir, runId: "run-rt-7" },
      ),
      (e: unknown) =>
        e instanceof WorkflowError &&
        e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        /agent\(\) 或 runTool\(\)/.test(e.message),
    )
  })()
})

// ============================================================
// 边界
// ============================================================

test("runTool 边界：不存在 / 非白名单 / 项目外 / symlink 逃逸 / 超时", async () => {
  await withTempDir(async (dir) => {
    // 不存在（TOOL_FAILED 可恢复）
    await assert.rejects(
      runWorkflow(META + `await runTool("tools/absent.py")`, { agent: fakeAgent([]), cwd: dir, runId: "run-rt-e1" }),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.TOOL_FAILED && /不存在/.test(e.message),
    )

    // 非白名单扩展名（SCRIPT_VALIDATION_ERROR 不可恢复）
    const txt = path.join(dir, "tools", "evil.txt")
    mkdirSync(path.dirname(txt), { recursive: true })
    writeFileSync(txt, "x", "utf8")
    await assert.rejects(
      runWorkflow(META + `await runTool("tools/evil.txt")`, { agent: fakeAgent([]), cwd: dir, runId: "run-rt-e2" }),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && /白名单/.test(e.message),
    )

    // 项目外路径
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "p41-outside-"))
    try {
      const outTool = path.join(outside, "escape.py")
      writeFileSync(outTool, "print('outside')\n", "utf8")
      await assert.rejects(
        runWorkflow(META + `await runTool(${JSON.stringify(outTool)})`, { agent: fakeAgent([]), cwd: dir, runId: "run-rt-e3" }),
        (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && /项目目录内/.test(e.message),
      )
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }

    // symlink 逃逸：项目内 symlink 指向项目外脚本
    if (process.platform !== "win32" || isSymlinkSupported()) {
      const outside2 = fs.mkdtempSync(path.join(os.tmpdir(), "p41-outside2-"))
      try {
        const realTool = path.join(outside2, "real.py")
        writeFileSync(realTool, "print('escaped')\n", "utf8")
        const link = path.join(dir, "tools", "link.py")
        try {
          symlinkSync(realTool, link)
        } catch {
          // Windows 无特权时跳过 symlink 子用例
          return
        }
        await assert.rejects(
          runWorkflow(META + `await runTool("tools/link.py")`, { agent: fakeAgent([]), cwd: dir, runId: "run-rt-e4" }),
          (e: unknown) => e instanceof WorkflowError && /项目目录内/.test(e.message),
        )
      } finally {
        fs.rmSync(outside2, { recursive: true, force: true })
      }
    }

    // 超时
    const slow = path.join(dir, "tools", "slow.py")
    writeFileSync(slow, `import time\ntime.sleep(3)\n`, "utf8")
    await assert.rejects(
      runWorkflow(META + `await runTool("tools/slow.py", { timeoutMs: 300 })`, { agent: fakeAgent([]), cwd: dir, runId: "run-rt-e5" }),
      (e: unknown) => e instanceof WorkflowError && e.code === WorkflowErrorCode.TOOL_FAILED,
    )
  })()
})

function isSymlinkSupported(): boolean {
  const probe = path.join(os.tmpdir(), `p41-symprobe-${Date.now()}`)
  try {
    symlinkSync(probe, `${probe}.link`)
    fs.rmSync(`${probe}.link`)
    return true
  } catch {
    return false
  }
}

// ============================================================
// Journal：executions 记录（无 hash）
// ============================================================

test("journal：runTool 执行记录走 executions 通道，不写 hash（resume 必 miss）", async () => {
  await withTempDir(async (dir) => {
    writePyTool(dir, "{'status': 'ok'}")
    const entries = new Map<string, JournalEntry>()
    const r = await runWorkflow(
      META + `const result = await runTool("tools/probe.py")\nreturn result`,
      {
        agent: fakeAgent([]),
        cwd: dir,
        runId: "run-rt-j1",
        onAgentJournal: (entry) => entries.set(entry.key, entry as JournalEntry),
        onAgentExecution: ({ key, execution }) => {
          // executions 经由 recordExecution 通道（这里捕获回调验证发射）
          assert.ok(key.startsWith("run-rt-j1:"), `key 形如 runId:callIndex，实际 ${key}`)
          assert.equal(execution.status, "ok")
          assert.match(execution.label ?? "", /^tool /)
        },
      },
    )
    assert.equal(r.toolCount, 1)
    // runTool 不写 journal entry 本体（无 hash/result 回放面）
    assert.equal(entries.size, 0, "runTool 不写 entry 本体（resume 永远 miss 重跑）")
  })()
})

// ============================================================
// Resume：下游 agent 依赖 runTool 输出的失效链路
// ============================================================

test("resume：runTool 输出变化 -> 下游 agent prompt 变 -> 不复用旧缓存", async () => {
  await withTempDir(async (dir) => {
    const store = new JournalStore(dir)
    writePyTool(dir, "{'version': 1}")

    const script = (toolRel: string) =>
      META + `
const data = await runTool(${JSON.stringify(toolRel)}, { parseJson: true })
const report = await agent("根据数据写报告：" + JSON.stringify(data.parsed))
return report
`
    // 第一次执行：runTool v1 + agent 消费
    const prompts1: string[] = []
    await runWorkflow(script("tools/probe.py"), {
      agent: fakeAgent(prompts1),
      cwd: dir,
      runId: "run-rt-r1",
      onAgentJournal: (entry) => store.append("run-rt-r1", entry.key, entry),
    })
    assert.equal(prompts1.length, 1)
    assert.match(prompts1[0], /"version":1/)

    // 工具输出变为 v2：resume 时 runTool 重跑（executions 无 hash 必 miss），
    // 下游 agent prompt 含新输出 -> hash 不匹配 -> 重跑（不复用缓存）
    writePyTool(dir, "{'version': 2}")
    const prompts2: string[] = []
    const resumed = await runWorkflow(script("tools/probe.py"), {
      agent: fakeAgent(prompts2),
      cwd: dir,
      runId: "run-rt-r1",
      resumeJournal: store.load("run-rt-r1"),
    })
    assert.equal(prompts2.length, 1, "下游 agent 因 prompt 变化重跑（缓存失效）")
    assert.match(prompts2[0], /"version":2/, "重跑时消费的是新输出")
    const result = resumed.result as string
    assert.match(result, /echo:/)
  })()
})

test("resume：runTool 输出未变时下游 agent 命中缓存（不重跑）", async () => {
  await withTempDir(async (dir) => {
    const store = new JournalStore(dir)
    writePyTool(dir, "{'version': 1}")
    const script =
      META + `
const data = await runTool("tools/probe.py", { parseJson: true })
const report = await agent("根据数据写报告：" + JSON.stringify(data.parsed))
return report
`
    const prompts1: string[] = []
    await runWorkflow(script, {
      agent: fakeAgent(prompts1),
      cwd: dir,
      runId: "run-rt-r2",
      onAgentJournal: (entry) => store.append("run-rt-r2", entry.key, entry),
    })
    const prompts2: string[] = []
    await runWorkflow(script, {
      agent: fakeAgent(prompts2),
      cwd: dir,
      runId: "run-rt-r2",
      resumeJournal: store.load("run-rt-r2"),
    })
    assert.equal(prompts2.length, 0, "输出未变 -> prompt 未变 -> agent 命中缓存回放")
  })()
})
