/**
 * worktree 隔离测试（P1-5，跑真实 git，照搬 Pi worktree.test.ts 套路）
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createWorktree, removeWorktree } from "../src/isolation/worktree.js"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner, AgentRunOptions } from "../src/agent/session-runner.js"

/** 造一个带一次提交的临时 git 仓库 */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-worktree-"))
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true })
  git(["init", "-b", "main"])
  git(["config", "user.email", "test@test"])
  git(["config", "user.name", "test"])
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n")
  git(["add", "."])
  git(["commit", "-m", "init"])
  return dir
}

test("createWorktree：隔离目录与分支创建成功，文件改动互不影响", async () => {
  const repo = makeGitRepo()
  try {
    const wt = await createWorktree(repo, "run-x-0-label")
    assert.equal(wt.isolated, true)
    assert.ok(wt.cwd.includes(".opencode-workflows/worktrees"))
    assert.equal(wt.branch, "wf/run-x-0-label")
    assert.ok(fs.existsSync(path.join(wt.cwd, "base.txt")), "worktree 含基准提交的文件")

    // 在 worktree 里改文件，不影响 base tree
    fs.writeFileSync(path.join(wt.cwd, "new.txt"), "isolated\n")
    assert.ok(!fs.existsSync(path.join(repo, "new.txt")), "base 目录不受 worktree 改动影响")

    await removeWorktree(wt)
    assert.ok(!fs.existsSync(wt.cwd), "worktree 目录已拆除")
    const branches = execFileSync("git", ["branch", "--list", "wf/run-x-0-label"], {
      cwd: repo,
      windowsHide: true,
    })
      .toString()
      .trim()
    assert.equal(branches, "", "分支已删除")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("createWorktree：非 git 目录静默降级共享目录", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-plain-"))
  try {
    const wt = await createWorktree(dir, "slug")
    assert.equal(wt.isolated, false)
    assert.equal(wt.cwd, dir)
    assert.ok(wt.reason, "降级原因已给出")
    // 降级时 removeWorktree 为 no-op，不抛错
    await removeWorktree(wt)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runtime：isolation worktree 的 agent 收到 worktree 目录，结束自动拆除", async () => {
  const repo = makeGitRepo()
  try {
    const seenDirectories: Array<string | undefined> = []
    const runner: AgentSessionRunner = {
      async run(_prompt, options?: AgentRunOptions) {
        seenDirectories.push(options?.directory)
        return "ok"
      },
    }
    const result = await runWorkflow(
      `export const meta = { name: 'wt1' }\nreturn await agent('改文件', { isolation: 'worktree', agentType: 'general' })`,
      { agent: runner, cwd: repo },
    )
    assert.equal(result.result, "ok")
    assert.equal(seenDirectories.length, 1)
    assert.ok(seenDirectories[0], "应传入 worktree 目录")
    assert.ok(seenDirectories[0]!.includes(".opencode-workflows/worktrees"))
    // 运行结束后 worktree 已拆除
    const worktreesDir = path.join(repo, ".opencode-workflows", "worktrees")
    const leftover = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : []
    assert.equal(leftover.length, 0, "worktree 已清理")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("runtime：无 isolation 的 agent 不传 directory", async () => {
  const repo = makeGitRepo()
  try {
    const seen: Array<string | undefined> = []
    const runner: AgentSessionRunner = {
      async run(_p, options) {
        seen.push(options?.directory)
        return "ok"
      },
    }
    await runWorkflow(`export const meta = { name: 'wt2' }\nreturn await agent('x')`, {
      agent: runner,
      cwd: repo,
    })
    assert.equal(seen[0], undefined)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("runtime：非 git 目录中 isolation 降级并记录日志", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-degrade-"))
  try {
    const seen: Array<string | undefined> = []
    const runner: AgentSessionRunner = {
      async run(_p, options) {
        seen.push(options?.directory)
        return "ok"
      },
    }
    const result = await runWorkflow(
      `export const meta = { name: 'wt3' }\nreturn await agent('x', { isolation: 'worktree' })`,
      { agent: runner, cwd: dir },
    )
    assert.equal(result.result, "ok")
    assert.equal(seen[0], undefined, "降级共享目录时不传 directory")
    assert.ok(result.logs.some((l) => l.includes("降级共享目录")))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
