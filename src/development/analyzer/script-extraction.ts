/**
 * P3-C Rule 5: Script Extraction 候选检测
 *
 * 识别步骤：
 *  1. 找 write/edit 工具调用，提取 input.content 和 input.filePath
 *     - edit 工具的 input 通常只含修改片段，标记 scriptContent 为片段
 *  2. 找 bash 工具调用，检测 input.command 中的 heredoc
 *  3. 关联后续执行：同 filePath 出现在 bash 的 input.command 中
 *  4. 检查工具调用状态：status = completed（仅代表工具层面完成）
 *  5. 确定性评估（三档，非布尔值）：
 *     - unlikely：含 Date.now/Math.random/new Date/time.time 等非确定性 API
 *     - unknown：含网络调用关键字或无法判断
 *     - likely：无上述特征
 *
 * TypeScript 规则负责发现"创建->执行"的事实；
 * LLM 负责判断是否值得固化（审阅阶段）；
 * 真正的可复用性通过后续回归测试证明。
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import type {
  AnalysisToolEvent,
  ScriptExtractionCandidate,
  DeterminismAssessment,
} from "./types.js"

/**
 * 规则 5：Script Extraction 候选检测
 *
 * @param events 分析事件列表（已按时间排序）
 * @returns ScriptExtractionCandidate[]
 */
export function detectScriptExtractions(events: AnalysisToolEvent[]): ScriptExtractionCandidate[] {
  const candidates: ScriptExtractionCandidate[] = []

  // 1. 收集脚本创建事件
  const scriptCreates = collectScriptCreates(events)

  for (const create of scriptCreates) {
    // 2. 关联后续执行事件（区分确认执行和可能提及）
    const { confirmed, possible } = findExecutionEvents(events, create)

    // 3. 如果没有确认执行事件，跳过（只关心被实际执行的脚本）
    if (confirmed.length === 0) continue

    // 4. 检查工具调用完成状态
    const toolCallCompleted = create.event.status === "completed"

    // 5. 评估确定性
    const determinism = assessDeterminism(create.scriptContent)

    candidates.push({
      sourceTool: create.sourceTool,
      scriptContent: create.scriptContent,
      filePath: create.filePath,
      createEvent: create.event,
      executionEvents: confirmed,
      possibleExecutions: possible,
      toolCallCompleted,
      observedExecutions: confirmed.length,
      determinism,
    })
  }

  // 6. 处理 bash heredoc 创建的脚本
  const heredocCreates = collectHeredocCreates(events)
  for (const heredoc of heredocCreates) {
    const { confirmed, possible } = findExecutionEvents(events, {
      filePath: heredoc.filePath,
      event: heredoc.event,
    })

    if (confirmed.length === 0) continue

    const determinism = assessDeterminism(heredoc.scriptContent)

    candidates.push({
      sourceTool: "bash",
      scriptContent: heredoc.scriptContent,
      filePath: heredoc.filePath,
      createEvent: heredoc.event,
      executionEvents: confirmed,
      possibleExecutions: possible,
      toolCallCompleted: heredoc.event.status === "completed",
      observedExecutions: confirmed.length,
      determinism,
    })
  }

  return candidates
}

// ============================================================
// 脚本创建事件收集
// ============================================================

interface ScriptCreate {
  event: AnalysisToolEvent
  sourceTool: "write" | "edit"
  scriptContent: string
  filePath: string
}

/** 收集 write/edit 工具创建的脚本 */
function collectScriptCreates(events: AnalysisToolEvent[]): ScriptCreate[] {
  const creates: ScriptCreate[] = []

  for (const event of events) {
    if (event.tool === "write") {
      const content = event.input.content as string | undefined
      const filePath = event.input.filePath as string | undefined
      if (content && filePath && isScriptFile(filePath)) {
        creates.push({
          event,
          sourceTool: "write",
          scriptContent: content,
          filePath,
        })
      }
    } else if (event.tool === "edit") {
      const filePath = event.input.filePath as string | undefined
      // edit 工具的 input 通常只含 oldString/newString 片段，不是完整文件
      const newString = event.input.newString as string | undefined
      if (filePath && newString && isScriptFile(filePath)) {
        // edit 片段无法还原完整脚本，scriptContent 只保留片段
        creates.push({
          event,
          sourceTool: "edit",
          scriptContent: newString,
          filePath,
        })
      }
    }
  }

  return creates
}

// ============================================================
// Heredoc 脚本提取
// ============================================================

interface HeredocCreate {
  event: AnalysisToolEvent
  scriptContent: string
  filePath: string
}

/** 收集 bash heredoc 创建的脚本 */
function collectHeredocCreates(events: AnalysisToolEvent[]): HeredocCreate[] {
  const creates: HeredocCreate[] = []

  for (const event of events) {
    if (event.tool !== "bash") continue
    const command = event.input.command as string | undefined
    if (!command) continue

    const heredoc = extractHeredoc(command)
    if (heredoc) {
      // 从 command 中提取输出文件路径
      const filePath = extractHeredocFilePath(command)
      if (filePath) {
        creates.push({
          event,
          scriptContent: heredoc.content,
          filePath,
        })
      }
    }
  }

  return creates
}

/**
 * 从 bash command 中提取 heredoc 脚本内容
 *
 * 支持格式：
 *   cat <<'EOF' > file.py
 *   ...script content...
 *   EOF
 *
 *   cat <<EOF > file.py
 *   ...
 *   EOF
 */
export function extractHeredoc(command: string): { content: string; language: string } | null {
  // 匹配 cat <<'DELIMITER' 或 cat <<DELIMITER 后面跟 > filename 或 > "filename"
  const heredocStart = command.match(/<<['"]?(\w+)['"]?\s*>\s*"?([^\s"]+)"?/)
  if (!heredocStart) return null

  const delimiter = heredocStart[1]
  const lines = command.split("\n")

  // 找到 heredoc 内容开始行（heredocStart 匹配的行之后）
  let startIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`<<`) && lines[i].includes(delimiter)) {
      startIndex = i + 1
      break
    }
  }

  if (startIndex === -1) return null

  // 收集内容直到遇到 delimiter 行
  const contentLines: string[] = []
  for (let i = startIndex; i < lines.length; i++) {
    if (lines[i].trim() === delimiter) break
    contentLines.push(lines[i])
  }

  if (contentLines.length === 0) return null

  const content = contentLines.join("\n")
  const filePath = heredocStart[2]
  const language = inferLanguageFromPath(filePath)

  return { content, language }
}

/** 从 heredoc 命令中提取输出文件路径 */
function extractHeredocFilePath(command: string): string | undefined {
  const match = command.match(/>\s*"?([^\s"]+)"?/)
  return match?.[1]
}

// ============================================================
// 执行事件关联
// ============================================================

/** 执行模式：匹配明确执行脚本的命令前缀 */
const EXECUTION_PATTERNS: Array<{ runtime: string; extensions: string[] }> = [
  { runtime: "python", extensions: ["py"] },
  { runtime: "python3", extensions: ["py"] },
  { runtime: "node", extensions: ["js", "mjs", "cjs"] },
  { runtime: "npx", extensions: ["js", "ts"] },
  { runtime: "tsx", extensions: ["ts"] },
  { runtime: "bash", extensions: ["sh", "bash"] },
  { runtime: "sh", extensions: ["sh", "bash"] },
  { runtime: "ruby", extensions: ["rb"] },
  { runtime: "perl", extensions: ["pl"] },
  { runtime: "lua", extensions: ["lua"] },
  { runtime: "go", extensions: ["go"] },
  { runtime: "cargo", extensions: ["rs"] },
  { runtime: "java", extensions: ["java"] },
]

/**
 * 查找后续执行同一文件的事件
 *
 * P3.1 修正：
 *  - 区分"确认执行"和"可能提及"
 *  - 确认执行：命令以 `python script.py`、`node script.js` 等形式开头
 *  - 可能提及：命令中包含文件名但不是执行形式（如 `echo "check script.py"`）
 *  - 只收集 status=completed 或 status=error 的事件（跳过 pending/running）
 *
 * @returns confirmed=已确认执行, possible=可能提及但未确认
 */
function findExecutionEvents(
  events: AnalysisToolEvent[],
  create: { filePath: string; event: AnalysisToolEvent },
): { confirmed: AnalysisToolEvent[]; possible: AnalysisToolEvent[] } {
  const confirmed: AnalysisToolEvent[] = []
  const possible: AnalysisToolEvent[] = []
  const createTs = create.event.startedAt ?? 0
  const fileName = getBaseName(create.filePath)
  const fileExt = getFileExtension(create.filePath)

  for (const event of events) {
    // 跳过创建事件本身
    if (event.callID === create.event.callID) continue
    // 只看创建之后的事件
    if ((event.startedAt ?? 0) < createTs) continue
    // 只看 bash 工具
    if (event.tool !== "bash") continue
    // P3.1: 只收集 completed 或 error 的事件（跳过 pending/running）
    if (event.status !== "completed" && event.status !== "error") continue

    const command = event.input.command as string | undefined
    if (!command) continue

    // 检查命令是否包含文件路径或文件名
    const mentionsFile = command.includes(create.filePath) || command.includes(fileName)
    if (!mentionsFile) continue

    // 检查是否为明确的执行形式
    if (isConfirmedExecution(command, fileName, fileExt)) {
      confirmed.push(event)
    } else {
      possible.push(event)
    }
  }

  return { confirmed, possible }
}

/** 判断命令是否为明确的脚本执行形式 */
function isConfirmedExecution(command: string, fileName: string, fileExt: string | undefined): boolean {
  const trimmedCmd = command.trim()

  for (const pattern of EXECUTION_PATTERNS) {
    // 检查 `runtime fileName` 或 `runtime ./fileName` 或 `runtime path/to/fileName`
    const execRegex = new RegExp(`^${pattern.runtime}\\s+.*${escapeRegex(fileName)}`)
    if (execRegex.test(trimmedCmd)) return true

    // 也检查直接执行形式 `./script.sh`
    if (pattern.extensions.includes(fileExt ?? "")) {
      const directExecRegex = new RegExp(`^\\.?/?.*${escapeRegex(fileName)}`)
      if (directExecRegex.test(trimmedCmd) && !trimmedCmd.startsWith("echo") && !trimmedCmd.startsWith("cat") && !trimmedCmd.startsWith("type")) {
        return true
      }
    }
  }

  return false
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 获取文件扩展名（不含点） */
function getFileExtension(filePath: string): string | undefined {
  const match = filePath.match(/\.([^.]+)$/)
  return match?.[1]?.toLowerCase()
}

// ============================================================
// 确定性评估
// ============================================================

/** 非确定性 API 关键字（匹配则 determinism=unlikely） */
const NONDETERMINISTIC_PATTERNS = [
  /\bDate\.now\b/,
  /\bMath\.random\b/,
  /\bnew Date\b/,
  /\btime\.time\b/,
  /\btime\.monotonic\b/,
  /\brandom\.random\b/,
  /\buuid\b/i,
  /\bgetpid\b/,
]

/** 网络调用关键字（匹配则 determinism=unknown） */
const NETWORK_PATTERNS = [
  /\brequests\.(get|post|put|delete|patch|head)\b/,
  /\bfetch\b/,
  /\bhttp\.(get|post|request)\b/,
  /\burllib\b/,
  /\bsocket\b/,
  /\bhttp\.client\b/,
  /\baiohttp\b/,
  /\bsubprocess\b/,
  /\bos\.system\b/,
  /\bos\.popen\b/,
  /\bsystem_call\b/,
]

/**
 * 评估脚本确定性（三档，非布尔值）
 *
 * unlikely：含 Date.now/Math.random/new Date 等非确定性 API
 * unknown：含网络/外部依赖或无法判断
 * likely：无上述特征
 */
export function assessDeterminism(scriptContent: string): DeterminismAssessment {
  // 先检查非确定性 API（优先级更高）
  for (const pattern of NONDETERMINISTIC_PATTERNS) {
    if (pattern.test(scriptContent)) {
      return "unlikely"
    }
  }

  // 再检查网络/外部依赖
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(scriptContent)) {
      return "unknown"
    }
  }

  return "likely"
}

// ============================================================
// 辅助函数
// ============================================================

/** 判断文件是否为脚本文件（按扩展名） */
function isScriptFile(filePath: string): boolean {
  return /\.(py|js|ts|sh|rb|pl|lua|go|rs|java|c|cpp|h)$/i.test(filePath)
}

/** 获取文件名（不含目录） */
function getBaseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/")
  return parts[parts.length - 1] || filePath
}

/** 从文件路径推断语言 */
function inferLanguageFromPath(filePath: string): string {
  if (filePath.endsWith(".py")) return "python"
  if (filePath.endsWith(".js") || filePath.endsWith(".ts")) return "javascript"
  if (filePath.endsWith(".sh")) return "bash"
  if (filePath.endsWith(".rb")) return "ruby"
  if (filePath.endsWith(".go")) return "go"
  if (filePath.endsWith(".rs")) return "rust"
  return "unknown"
}
