/**
 * Worktree 隔离（P1-5，回落路径）
 *
 * 生命周期：
 *  createWorktree(baseCwd, slug)
 *   -> git rev-parse --show-toplevel 找仓库根
 *   -> git worktree add -b wf/<slug> <repoRoot>/.opencode-workflows/worktrees/<slug> HEAD
 *   -> { isolated: true, cwd, branch }
 *   （非 git 目录或失败 -> { isolated: false, cwd: baseCwd, reason }，静默降级，与 Pi 一致）
 *
 *  removeWorktree(wt)
 *   -> git worktree remove --force + git branch -D（best-effort，失败不抛）
 *
 * 注意（照搬 Pi worktree.ts 立场）：
 *  - 结果不自动合并：路径暴露给调用方（prompt 经 directory query 路由到 worktree）
 *  - 失败静默降级为共享目录运行，只 log 一行
 *  - 确定性命名（runId-callIndex-label）保证 resume 时 key 稳定
 *
 * 原生路径说明：OpenCode 服务端有 experimental worktree API（experimental.ts:190+），
 * 但 v1 SDK 客户端未暴露；待 SDK 暴露后可切原生（需求 F-16 两段式）。
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  isolated: boolean
  cwd: string
  branch?: string
  /** 主仓库根（创建时记下；拆除时绝不能站在 worktree 里执行 git，否则拆不掉自己） */
  repoRoot?: string
  reason?: string
}

/** slug 安全化：只留字母数字连字符下划线 */
function sanitizeSlugPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "agent"
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, windowsHide: true })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: (err.stdout ?? "").toString().trim(), stderr: (err.stderr ?? err.message ?? "").toString().trim() }
  }
}

/** 创建隔离 worktree；失败静默降级为共享目录 */
export async function createWorktree(baseCwd: string, slug: string): Promise<WorktreeInfo> {
  const safeSlug = sanitizeSlugPart(slug)
  const rootResult = await git(baseCwd, ["rev-parse", "--show-toplevel"])
  if (!rootResult.ok) {
    return { isolated: false, cwd: baseCwd, reason: `非 git 仓库（${rootResult.stderr.slice(0, 80)}）` }
  }
  const repoRoot = rootResult.stdout
  const branch = `wf/${safeSlug}`
  // 目录统一正斜杠：服务端 directory 键为正斜杠规范形（git/workspace 体系均如此），
  // Windows 下 path.join 的反斜杠会导致 query 路由匹配失败退回 cwd（真机 run-mtmj353a 实证）
  const worktreePath = path.join(repoRoot, ".opencode-workflows", "worktrees", safeSlug).replace(/\\/g, "/")
  const addResult = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"])
  if (!addResult.ok) {
    return { isolated: false, cwd: baseCwd, reason: `git worktree add 失败（${addResult.stderr.slice(0, 80)}）` }
  }
  return { isolated: true, cwd: worktreePath, branch, repoRoot: repoRoot.replace(/\\/g, "/") }
}

/** 拆除 worktree 与分支（best-effort；共享目录降级时为 no-op） */
export async function removeWorktree(worktree: WorktreeInfo): Promise<void> {
  if (!worktree.isolated || !worktree.branch) return
  // 必须从主仓库根执行：在 worktree 内执行 git worktree remove 会拒绝拆除当前工作树
  const root = worktree.repoRoot ?? (await git(worktree.cwd, ["rev-parse", "--show-toplevel"])).stdout
  if (!root) return
  await git(root, ["worktree", "remove", "--force", worktree.cwd])
  await git(root, ["branch", "-D", worktree.branch])
}

/** 供测试与调用方确认目录存在性 */
export function worktreeExists(worktreePath: string): boolean {
  try {
    return fs.statSync(worktreePath).isDirectory()
  } catch {
    return false
  }
}
