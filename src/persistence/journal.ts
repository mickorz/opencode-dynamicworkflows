/**
 * JournalStore —— workflow 运行日志的文件持久化（P1-1）
 *
 * 存储布局：
 *  <项目目录>/.opencode-workflows/journal/<runId>.json
 *   -> { version: 1, runId: "...", entries: { "runId:callIndex": { hash, result, model? } } }
 *
 * 写入时机：runtime 的 onAgentJournal 回调（每个成功 live agent 完成即追加），
 * 因此 Esc 中断后已完成的 agent 也可续跑回放。
 *
 * 注意：结果对象可能含 vm 域原型（脚本组装的返回值），JSON 序列化天然抹平，无跨域问题。
 */

import fs from "node:fs"
import path from "node:path"
import type { JournalEntry } from "../types/index.js"

const JOURNAL_DIR = path.join(".opencode-workflows", "journal")
/** runId 只允许出现在文件名里的安全字符 */
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]+$/

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

  /** 追加一条 entry（读-合-写整个文件；同步 IO，非热路径） */
  append(runId: string, key: string, entry: JournalEntry): void {
    const parsed = this.read(runId)
    parsed.entries[key] = entry
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.file(runId), JSON.stringify(parsed), "utf8")
  }

  private file(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`非法 runId: ${runId}`)
    return path.join(this.dir, `${runId}.json`)
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
