/**
 * TraceStore —— Trace 文件的持久化（P1）
 *
 * 存储布局：
 *  <项目目录>/.opencode-workflows/history/<runId>/
 *    manifest.json     -> TraceManifest
 *    traces/<sid>.jsonl -> 每行一个 ToolCallEvent（JSON）
 *    history.jsonl     -> 合并后的全局时间线
 *    history.md         -> 人可读整理视图
 *
 * 写入时机：RunFinalizer 在 Run 终态后逐 session 写入。
 * 读取时机：HistoryBuilder 合并时读 traces/；Resume 时检查原始 Trace 是否存在。
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

export class TraceStore {
  private readonly baseDir: string

  constructor(projectDir: string) {
    this.baseDir = join(projectDir, HISTORY_DIR)
  }

  /** Run 的 History 根目录 */
  runDir(runId: string): string {
    return join(this.baseDir, runId)
  }

  /** 写入单会话 Trace（JSONL：每行一个事件） */
  writeSessionTrace(runId: string, sessionId: string, events: ToolCallEvent[]): void {
    const dir = join(this.runDir(runId), "traces")
    const file = join(dir, `${sessionId}.jsonl`)
    const lines = events.map((e) => JSON.stringify(e)).join("\n")
    this.writeAtomic(file, lines + "\n")
  }

  /** 写入 manifest */
  writeManifest(runId: string, manifest: TraceManifest): void {
    const file = join(this.runDir(runId), "manifest.json")
    this.writeAtomic(file, JSON.stringify(manifest, null, 2))
  }

  /** 写入合并后的 History（JSONL） */
  writeHistory(runId: string, jsonl: string): void {
    const file = join(this.runDir(runId), "history.jsonl")
    this.writeAtomic(file, jsonl)
  }

  /** 写入人可读 History（Markdown） */
  writeHistoryMd(runId: string, md: string): void {
    const file = join(this.runDir(runId), "history.md")
    this.writeAtomic(file, md)
  }

  /** 读取单会话 Trace */
  readSessionTrace(runId: string, sessionId: string): ToolCallEvent[] {
    try {
      const file = join(this.runDir(runId), "traces", `${sessionId}.jsonl`)
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
  readManifest(runId: string): TraceManifest | null {
    try {
      const file = join(this.runDir(runId), "manifest.json")
      return JSON.parse(readFileSync(file, "utf8")) as TraceManifest
    } catch {
      return null
    }
  }

  /** 检查某 session 的 Trace 是否已存在（Resume provenance 用） */
  hasSessionTrace(runId: string, sessionId: string): boolean {
    try {
      accessSync(join(this.runDir(runId), "traces", `${sessionId}.jsonl`))
      return true
    } catch {
      return false
    }
  }

  /** P3: 写入分析报告到 history/<runId>/analysis/ */
  writeAnalysis(runId: string, reportMd: string, proposalsJson: string): void {
    const reportPath = join(this.runDir(runId), "analysis", "report.md")
    const proposalsPath = join(this.runDir(runId), "analysis", "proposals.json")
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
