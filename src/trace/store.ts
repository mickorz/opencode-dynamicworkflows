/**
 * TraceStore —— Trace 文件的持久化（P1 + P3.2）
 *
 * 存储布局（P3.2: Resume Attempt 隔离）：
 *  无 runAttemptId（兼容模式）:
 *    <项目目录>/.opencode-workflows/history/<runId>/
 *      manifest.json
 *      traces/<sid>.jsonl
 *      history.jsonl
 *      history.md
 *      analysis/report.md, proposals.json
 *
 *  有 runAttemptId（Resume 隔离模式）:
 *    <项目目录>/.opencode-workflows/history/<runId>/attempts/<safeId>/
 *      manifest.json
 *      traces/<sid>.jsonl
 *      history.jsonl
 *      history.md
 *      analysis/report.md, proposals.json
 *
 * P3.2 关键修正：runAttemptId 含冒号（如 run-xxx:abc），不能直接用作 Windows 目录名。
 * sanitizeForPath 将冒号等特殊字符替换为短横线。
 *
 * 写入时机：RunFinalizer 在 Run 终态后逐 session 写入。
 * 读取时机：HistoryBuilder 合并时读 traces/；Analyzer 读 manifest + traces。
 *
 * 落盘策略与 JournalStore / run-snapshot 一致：
 *  - 原子写（tmp + rename，Windows 下 unlink 后重试）
 *  - 落盘失败不阻断运行（Trace 是尽力而为的观测通道）
 *  - 同步 IO（非热路径，Run 已终态）
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, accessSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ToolCallEvent } from "./collector.js"
import type { TraceManifest } from "./types.js"

const HISTORY_DIR = join(".opencode-workflows", "history")

/**
 * P3.2: 将 runAttemptId 转换为文件系统安全的路径段
 * runAttemptId 通常格式为 "runId:randomSuffix"，冒号在 Windows 上不能用作目录名
 */
export function sanitizeForPath(id: string): string {
  return id.replace(/[:<>|?*"\\/]/g, "-")
}

export class TraceStore {
  private readonly baseDir: string

  constructor(projectDir: string) {
    this.baseDir = join(projectDir, HISTORY_DIR)
  }

  /**
   * Run 的 History 根目录
   * P3.2: 有 runAttemptId 时使用 attempts/<safeId>/ 子目录（Resume 隔离）
   */
  runDir(runId: string, runAttemptId?: string): string {
    if (runAttemptId) {
      const safeId = sanitizeForPath(runAttemptId)
      return join(this.baseDir, runId, "attempts", safeId)
    }
    return join(this.baseDir, runId)
  }

  /** 写入单会话 Trace（JSONL：每行一个事件） */
  writeSessionTrace(runId: string, sessionId: string, events: ToolCallEvent[], runAttemptId?: string): void {
    const dir = join(this.runDir(runId, runAttemptId), "traces")
    const file = join(dir, `${sessionId}.jsonl`)
    const lines = events.map((e) => JSON.stringify(e)).join("\n")
    this.writeAtomic(file, lines + "\n")
  }

  /** 写入 manifest */
  writeManifest(runId: string, manifest: TraceManifest, runAttemptId?: string): void {
    const file = join(this.runDir(runId, runAttemptId), "manifest.json")
    this.writeAtomic(file, JSON.stringify(manifest, null, 2))
  }

  /** 写入合并后的 History（JSONL） */
  writeHistory(runId: string, jsonl: string, runAttemptId?: string): void {
    const file = join(this.runDir(runId, runAttemptId), "history.jsonl")
    this.writeAtomic(file, jsonl)
  }

  /** 写入人可读 History（Markdown） */
  writeHistoryMd(runId: string, md: string, runAttemptId?: string): void {
    const file = join(this.runDir(runId, runAttemptId), "history.md")
    this.writeAtomic(file, md)
  }

  /** 读取单会话 Trace */
  readSessionTrace(runId: string, sessionId: string, runAttemptId?: string): ToolCallEvent[] {
    try {
      const file = join(this.runDir(runId, runAttemptId), "traces", `${sessionId}.jsonl`)
      const raw = readFileSync(file, "utf8")
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ToolCallEvent)
    } catch {
      return []
    }
  }

  /** 读取 manifest */
  readManifest(runId: string, runAttemptId?: string): TraceManifest | null {
    try {
      const file = join(this.runDir(runId, runAttemptId), "manifest.json")
      return JSON.parse(readFileSync(file, "utf8")) as TraceManifest
    } catch {
      return null
    }
  }

  /** 检查某 session 的 Trace 是否已存在（Resume provenance 用） */
  hasSessionTrace(runId: string, sessionId: string, runAttemptId?: string): boolean {
    try {
      accessSync(join(this.runDir(runId, runAttemptId), "traces", `${sessionId}.jsonl`))
      return true
    } catch {
      return false
    }
  }

  /** P3: 写入分析报告到 analysis/ 目录 */
  writeAnalysis(runId: string, reportMd: string, proposalsJson: string, runAttemptId?: string): void {
    const base = this.runDir(runId, runAttemptId)
    const reportPath = join(base, "analysis", "report.md")
    const proposalsPath = join(base, "analysis", "proposals.json")
    this.writeAtomic(reportPath, reportMd)
    this.writeAtomic(proposalsPath, proposalsJson)
  }

  /** 原子写：mkdir + tmp + rename（Windows 兼容，同 JournalStore / run-snapshot 范式） */
  private writeAtomic(file: string, content: string): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      try {
        writeFileSync(tmp, content, "utf8")
        try {
          renameSync(tmp, file)
        } catch {
          rmSync(file, { force: true })
          renameSync(tmp, file)
        }
      } catch {
        try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
      }
    } catch {
      // 落盘失败不阻断运行
    }
  }
}
