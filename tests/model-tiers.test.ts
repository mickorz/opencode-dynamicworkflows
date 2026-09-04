/**
 * model tier 分层测试（P1-3）
 *
 * 覆盖：
 *  - loadModelTiers：全局 + 项目 overlay 合并（项目同名键覆盖）
 *  - tier 解析为具体 model 传给 runner
 *  - 优先级：显式 model > tier
 *  - 未配置 tier：回退（不传 model）+ 每 run 每 tier 仅告警一次
 *  - tier 进 journal 哈希身份（换 tier 使缓存失效）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import { loadModelTiers } from "../src/agent/model-tiers.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"

test("loadModelTiers：全局 + 项目 overlay，项目同名键覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-tiers-"))
  const globalFile = path.join(dir, "global.json")
  const projectDir = path.join(dir, "project")
  fs.writeFileSync(
    globalFile,
    JSON.stringify({ tiers: { small: "a/small", medium: "a/medium", big: "a/big" } }),
    "utf8",
  )
  fs.mkdirSync(path.join(projectDir, ".opencode-workflows"), { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, ".opencode-workflows", "model-tiers.json"),
    JSON.stringify({ tiers: { small: "b/small-v2" } }),
    "utf8",
  )

  const tiers = loadModelTiers({ globalFile, projectDir })
  assert.equal(tiers.small, "b/small-v2", "项目覆盖全局")
  assert.equal(tiers.medium, "a/medium", "全局保留")
  assert.equal(tiers.big, "a/big")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("tier 解析为具体 model 传给 runner", async () => {
  const seen: Array<AgentRunOptions | undefined> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      seen.push(options)
      return "ok"
    },
  }
  const result = await runWorkflow(`export const meta = { name: 'tier1' }\nreturn await agent('x', { tier: 'small' })`, {
    agent: runner,
    resolveTier: (tier) => (tier === "small" ? "openai/gpt-4o-mini" : undefined),
  })
  assert.equal(result.agents[0].model, "openai/gpt-4o-mini")
  assert.equal(seen[0]?.model, "openai/gpt-4o-mini")
})

test("优先级：显式 model 覆盖 tier", async () => {
  const seen: Array<AgentRunOptions | undefined> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      seen.push(options)
      return "ok"
    },
  }
  await runWorkflow(
    `export const meta = { name: 'tier2' }\nreturn await agent('x', { tier: 'small', model: 'anthropic/opus-4' })`,
    { agent: runner, resolveTier: () => "openai/gpt-4o-mini" },
  )
  assert.equal(seen[0]?.model, "anthropic/opus-4")
})

test("未配置 tier：不传 model 回退会话默认，且每 tier 只告警一次", async () => {
  const seen: Array<AgentRunOptions | undefined> = []
  const runner: AgentSessionRunner = {
    async run(_prompt, options) {
      seen.push(options)
      return "ok"
    },
  }
  const result = await runWorkflow(
    `export const meta = { name: 'tier3' }\nawait agent('a', { tier: 'ghost' })\nawait agent('b', { tier: 'ghost' })\nreturn 'done'`,
    { agent: runner, resolveTier: () => undefined },
  )
  assert.equal(seen[0]?.model, undefined)
  assert.equal(seen[1]?.model, undefined)
  const warnings = result.logs.filter((l) => l.includes('tier "ghost" 未配置'))
  assert.equal(warnings.length, 1, "同一 tier 只告警一次")
})

test("tier 参与哈希：换 tier 后缓存失效重跑", async () => {
  const scriptA = `export const meta = { name: 'tier4' }\nreturn await agent('x', { tier: 'small' })`
  const scriptB = `export const meta = { name: 'tier4' }\nreturn await agent('x', { tier: 'big' })`
  const journal = new Map()
  const first = await runWorkflow(scriptA, {
    agent: { async run: () => "a" } as AgentSessionRunner,
    resolveTier: () => "openai/gpt-4o-mini",
    onAgentJournal: (e) => journal.set(e.key, e),
  })

  let liveCalls = 0
  const resumed = await runWorkflow(scriptB, {
    agent: {
      async run() {
        liveCalls++
        return "b"
      },
    } as AgentSessionRunner,
    resolveTier: () => "anthropic/opus-4",
    runId: first.runId,
    resumeJournal: journal,
  })
  assert.equal(liveCalls, 1, "换 tier 应缓存失效重跑")
  assert.equal(resumed.agents[0].replayed, undefined)
})
