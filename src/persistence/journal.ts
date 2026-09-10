/**
 * JournalStore —— workflow 运行日志的文件持久化（P1-1）
 *
 * 存储布局：
 *  <项目目录>/.opencode-workflows/journal/<runId>.json
 *   -> { version: 1, runId: "...", entries: { "runId:callIndex": { hash, result, model?, ...展示元数据 } } }
 *
 * 写入时机：runtime 的 onAgentJournal 回调（每个成功 live agent 完成即追加），
 * 因此 Esc 中断后已完成的 agent 也可续跑回放。
 *
 * Node Inspector 扩展（FR-3/FR-6/FR-7）：
 *  - entry 增加可选展示元数据（label/sessionId/outputType/usage 等），老 journal 无这些字段照常可读
 *  - recordExecution 追加失败/中止 attempt 的执行历史（executions[]，绝不写 hash/result，
 *    resume 语义不受影响：仅 executions 无 hash 的 entry 永远 miss 重跑）
 *  - 写入改为原子（tmp+rename，Windows 下 rename 覆盖失败先 unlink 再重试；范式同 run-snapshot.ts）
 *
 * 注意：结果对象可能含 vm 域原型（脚本组装的返回值），JSON 序列化天然抹平，无跨域问题。
 */

import fs from "node:fs"
import path from "node:path"
import type { AgentExecutionRecord, JournalEntry } from "../types/index.js"

const JOURNAL_DIR = path.join(".opencode-workflows", "journal")
/** runId 只允许出现在文件名里的安全字符 */
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]+$/
/** executions 历史保留上限（retry 极端场景封顶） */
const EXECUTIONS_CAP = 10

interface JournalFile {
  version: 1
  runId: string
  entries: Record<string, JournalEntry>
}

export class JournalStore {
  private readonly dir: string
  /** runId -> 内存态（同一 run 内多次追加只读一次盘） */
  private readonly cache = new Map<string, JournalFile>()

  constructor(projectDir: string) {
    this.dir = path.join(projectDir, JOURNAL_DIR)
  }

  /** 加载某次 run 的 journal 为回放用的 Map；不存在返回空 Map */
  load(runId: string): Map<string, JournalEntry> {
    return new Map(Object.entries(this.read(runId).entries))
  }

  /**
   * 追加一条 entry（读-合-写整个文件；同步 IO，非热路径）。
   * 浅合并语义：新载荷不带 executions 时保留已有执行历史（成功写入不覆盖失败历史）；
   * hash/result 以新载荷为准。
   */
  append(runId: string, key: string, entry: JournalEntry): void {
    this.assertSafeRunId(runId)
    const parsed = this.read(runId)
    const prev = parsed.entries[key]
    parsed.entries[key] = { ...prev, ...entry, executions: entry.executions ?? prev?.executions }
    this.writeAtomic(runId, parsed)
  }

  /**
   * 追加一条 attempt 执行记录（FR-7）：同 executionId 去重，保留最近 EXECUTIONS_CAP 条。
   * 绝不写 hash/result —— resume 按 hash 命中回放，这里只丰富展示面的执行历史。
   * 失败 entry 顺带补齐顶层 label/sessionId（快照被清理后 Node Detail header 的兜底来源）。
   */
  recordExecution(runId: string, key: string, execution: AgentExecutionRecord): void {
    this.assertSafeRunId(runId)
    const parsed = this.read(runId)
    const prev = parsed.entries[key] ?? {}
    const executions = [...(prev.executions ?? []).filter((e) => e.executionId !== execution.executionId), execution]
    parsed.entries[key] = {
      ...prev,
      label: prev.label ?? execution.label,
      sessionId: prev.sessionId ?? execution.sessionId,
      executions: executions.slice(-EXECUTIONS_CAP),
    }
    this.writeAtomic(runId, parsed)
  }

  /** runId 会进文件名，非法值是调用方 bug，直接抛错暴露（区别于 IO 失败的静默降级） */
  private assertSafeRunId(runId: string): void {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`非法 runId: ${runId}`)
  }

  private file(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`非法 runId: ${runId}`)
    return path.join(this.dir, `${runId}.json`)
  }

  /** 原子写：tmp 完整写入后 rename；Windows 下 rename 到已存在文件可能失败，unlink 后重试 */
  private writeAtomic(runId: string, parsed: JournalFile): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const file = this.file(runId)
      const tmp = `${file}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(parsed), "utf8")
        try {
          fs.renameSync(tmp, file)
        } catch {
          fs.rmSync(file, { force: true })
          fs.renameSync(tmp, file)
        }
      } catch {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          // 清理失败忽略
        }
      }
    } catch {
      // 落盘失败不阻断运行（journal 仅影响回放优化与 Node Detail 展示）
    }
  }

  private read(runId: string): JournalFile {
    const hit = this.cache.get(runId)
    if (hit) return hit
    let parsed: JournalFile = { version: 1, runId, entries: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(runId), "utf8")) as Partial<JournalFile>
      if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
        parsed = { version: 1, runId, entries: raw.entries }
      }
    } catch {
      // 文件不存在或损坏：从空 journal 开始，不阻断运行
    }
    this.cache.set(runId, parsed)
    return parsed
  }
}
