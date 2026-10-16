/**
 * ApprovalRecord 与 Candidate Bundle Apply（P4-0 契约三/四）
 *
 * 类头流程图：
 *
 *  checkpoint 人工批准（headless abort）
 *        |
 *        v
 *  宿主持久化 ApprovalRecord（ApprovalStore.save）
 *    绑定 optimizationId + originalScriptHash
 *      + candidateBundleHash + abResultHash
 *        |
 *        v
 *  OptimizationJob 状态机驱动 applyCandidate（多文件事务）
 *        |
 *        v
 *  1 无 ApprovalRecord -> 拒绝（虚假批准防线）
 *  2 批准记录哈希校验 bundleHash
 *        |
 *        v
 *  3 预检查 目标当前哈希 == 基线
 *        |
 *        v
 *  4 暂存全部源文件 -> 5 备份全部目标
 *        |
 *        v
 *  6 逐文件临时文件 rename 部署
 *        |
 *        v
 *  7 验证目标哈希 == 候选哈希
 *    一致 -> applied 写 apply-log
 *    不符 -> 从备份恢复全部 -> failed
 *
 * 约束（P4 执行文档 4.3.6）：
 *  - 只接受已落盘的 ApprovalRecord，不接受调用方裸传哈希
 *  - 候选是多文件事务（Workflow Patch + 固化工具）：任一文件部署失败整体失败并恢复
 *  - 纯宿主逻辑，不依赖 Agent；宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile, appendFile, copyFile, rm } from "node:fs/promises"
import { mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { sha256Text } from "./workflow-source.js"

/** P4-0 契约三：可信人工批准记录（审批与应用解耦的唯一凭证） */
export interface ApprovalRecord {
  optimizationId: string
  /** 原版主脚本基线哈希（与 manifest.workflowSource.scriptHash 同源） */
  originalScriptHash: string
  /** 候选全文件包哈希（bundleHash 计算，非仅 Workflow JS） */
  candidateBundleHash: string
  /** A/B 验证结果哈希（绑定批准与证据） */
  abResultHash: string
  approvedAt: number
  /** 批准事件来源（如 checkpoint 批准事件标识） */
  approvalChannel: string
}

/** ApprovalRecord 持久化：development/approval-records/<optimizationId>.json */
export class ApprovalStore {
  constructor(private readonly dir: string) {}

  private recordPath(optimizationId: string): string {
    return join(this.dir, `${optimizationId}.json`)
  }

  async save(record: ApprovalRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = this.recordPath(record.optimizationId) + ".tmp"
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8")
    await rename(tmp, this.recordPath(record.optimizationId))
  }

  async load(optimizationId: string): Promise<ApprovalRecord | undefined> {
    const p = this.recordPath(optimizationId)
    if (!existsSync(p)) return undefined
    return JSON.parse(await readFile(p, "utf8")) as ApprovalRecord
  }
}

/** 候选文件包中的一个文件：sourcePath 为候选产物，targetPath 为部署目标 */
export interface ApplyBundleEntry {
  sourcePath: string
  targetPath: string
}

export interface ApplyTarget {
  /** 候选全文件清单（Workflow Patch + 固化工具等） */
  targets: ApplyBundleEntry[]
  /** 目标文件基线哈希（应用前校验未被外部修改），key 为 targetPath */
  baselineHashes: Record<string, string>
  /** 部署后期望哈希（校验应用完整性），key 为 targetPath */
  candidateHashes: Record<string, string>
  /** 备份目录（应用前全部目标文件复制到此） */
  backupDir: string
  /** 应用台账路径（JSONL，追加一行） */
  applyLogPath: string
}

export interface ApplyResult {
  applied: boolean
  reason?: string
  backupPaths?: string[]
}

/**
 * 候选文件包哈希：对全部源文件内容按 targetPath 排序后哈希。
 * ApprovalRecord.candidateBundleHash 与此对齐，防止部署清单与批准内容不一致。
 */
export function bundleHash(files: Array<{ targetPath: string; content: string }>): string {
  const canonical = files
    .map((f) => ({ targetPath: f.targetPath, hash: sha256Text(f.content) }))
    .sort((a, b) => (a.targetPath < b.targetPath ? -1 : a.targetPath > b.targetPath ? 1 : 0))
  return sha256Text(JSON.stringify(canonical))
}

/**
 * 安全应用候选文件包（多文件事务，P4-D 的确定性应用核心）
 *
 * 调用方必须先经 ApprovalStore.load 取得已落盘的 ApprovalRecord；
 * record 为 undefined（无批准记录）或哈希不匹配时拒绝应用。
 */
export async function applyCandidate(
  record: ApprovalRecord | undefined,
  target: ApplyTarget,
): Promise<ApplyResult> {
  // 1. 批准记录校验：无落盘批准即拒绝（不接受调用方裸传哈希）
  if (!record) {
    return { applied: false, reason: "无 ApprovalRecord，拒绝应用" }
  }

  // 2. 暂存：读出全部源文件内容，计算实际 bundle 哈希与批准记录比对
  const staged: Array<{ targetPath: string; content: string }> = []
  for (const entry of target.targets) {
    staged.push({ targetPath: entry.targetPath, content: await readFile(entry.sourcePath, "utf8") })
  }
  const actualBundleHash = bundleHash(staged)
  if (actualBundleHash !== record.candidateBundleHash) {
    return { applied: false, reason: "候选文件包哈希与批准记录不匹配" }
  }

  // 3. 预检查：目标文件当前哈希 == 基线（任一不符拒绝应用）。
  //    基线约定 "<absent>" 表示新文件（固化工具首次部署，目标不存在是常态）
  for (const entry of target.targets) {
    const baseline = target.baselineHashes[entry.targetPath]
    if (baseline === "<absent>") {
      if (existsSync(entry.targetPath)) {
        return { applied: false, reason: `新文件目标已存在（与预期不符）：${entry.targetPath}` }
      }
      continue
    }
    if (!existsSync(entry.targetPath)) {
      return { applied: false, reason: `目标文件不存在：${entry.targetPath}` }
    }
    const current = sha256Text(await readFile(entry.targetPath, "utf8"))
    if (current !== baseline) {
      return { applied: false, reason: `原版文件已被修改，拒绝应用：${entry.targetPath}` }
    }
  }

  // 4. 备份：目标文件复制到 backupDir（新文件无备份，部署失败时直接删除回滚）
  mkdirSync(target.backupDir, { recursive: true })
  const backupPaths: string[] = []
  const newFiles: string[] = []
  for (const entry of target.targets) {
    if (target.baselineHashes[entry.targetPath] === "<absent>") {
      newFiles.push(entry.targetPath)
      continue
    }
    const backupPath = join(target.backupDir, entry.targetPath.replace(/[:\\/]/g, "_"))
    await copyFile(entry.targetPath, backupPath)
    backupPaths.push(backupPath)
  }

  // 5. 部署：逐文件临时文件 -> rename 原子替换
  const deployed: string[] = []
  for (const item of staged) {
    const tmp = item.targetPath + ".tmp"
    await mkdir(dirname(item.targetPath), { recursive: true })
    await writeFile(tmp, item.content, "utf8")
    await rename(tmp, item.targetPath)
    deployed.push(item.targetPath)
  }

  // 6. 验证：全部目标文件哈希 == 候选哈希；任一不符 -> 回滚（备份恢复 + 新文件删除） -> 失败
  const mismatched: string[] = []
  for (const item of staged) {
    const applied = sha256Text(await readFile(item.targetPath, "utf8"))
    if (applied !== target.candidateHashes[item.targetPath]) mismatched.push(item.targetPath)
  }
  if (mismatched.length > 0) {
    for (const item of staged) {
      const backupPath = join(target.backupDir, item.targetPath.replace(/[:\\/]/g, "_"))
      if (existsSync(backupPath)) await copyFile(backupPath, item.targetPath)
      else if (newFiles.includes(item.targetPath) && existsSync(item.targetPath)) {
        await rm(item.targetPath)
      }
    }
    return { applied: false, reason: `部署后哈希校验失败，已回滚全部文件：${mismatched.join(", ")}`, backupPaths }
  }

  // 7. 台账：追加应用日志（JSONL，路径由调用方指定）
  await appendFile(
    target.applyLogPath,
    JSON.stringify({
      ts: Date.now(),
      optimizationId: record.optimizationId,
      applied: true,
      targets: target.targets.map((t) => t.targetPath),
      backupPaths,
    }) + "\n",
    "utf8",
  )
  return { applied: true, backupPaths }
}
