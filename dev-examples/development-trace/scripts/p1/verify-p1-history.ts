/**
 * P1 History 落盘验证脚本
 *
 * 用法：
 *   先在 OpenCode 中跑完 p1-history-verify.js workflow，拿到 runId 后运行：
 *   npx tsx scripts/verify-p1-history.ts <runId> [directory]
 *
 *   不传 runId 时自动取 history 目录下最新的 run。
 *
 * 验证项（对应 P1 验收标准）：
 *   V-5  History 目录存在
 *   V-6  manifest completeness = full
 *   V-7  history.jsonl 按时间排序且含工具调用
 *   V-8  history.md 含执行树 + 工具序列
 *  V-10  采集失败不阻断（即便 completeness 非 full，manifest 仍写入）
 */

import fs from "node:fs"
import path from "node:path"

const directory = process.argv[3] ?? process.cwd()
const historyBase = path.join(directory, ".opencode-workflows", "history")

let runId = process.argv[2]
if (!runId) {
  if (!fs.existsSync(historyBase)) {
    console.error("[失败] History 目录不存在:", historyBase)
    console.error("请确认 workflow 已执行完成")
    process.exit(1)
  }
  const dirs = fs
    .readdirSync(historyBase)
    .filter((d) => fs.statSync(path.join(historyBase, d)).isDirectory())
    .sort()
  if (dirs.length === 0) {
    console.error("[失败] History 目录下无 run 子目录")
    process.exit(1)
  }
  runId = dirs[dirs.length - 1]
  console.log(`[信息] 未传 runId，自动取最新: ${runId}`)
}

const runDir = path.join(historyBase, runId)
console.log(`[信息] 检查: ${runDir}`)
console.log()

if (!fs.existsSync(runDir)) {
  console.error(`[失败] Run 目录不存在: ${runDir}`)
  process.exit(1)
}

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  const tag = ok ? "[通过]" : "[失败]"
  console.log(`${tag} ${name}${detail ? " — " + detail : ""}`)
  ok ? pass++ : fail++
}

// ============================================================
// 1. manifest.json
// ============================================================
console.log("=== 1. manifest.json ===")
const manifestPath = path.join(runDir, "manifest.json")
if (!fs.existsSync(manifestPath)) {
  check("manifest.json 存在", false)
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  check("manifest.json 存在", true)
  console.log(`  runId:          ${manifest.runId}`)
  console.log(`  runAttemptId:   ${manifest.runAttemptId}`)
  console.log(`  rootRunId:      ${manifest.rootRunId}`)
  console.log(`  status:         ${manifest.status}`)
  console.log(`  completeness:   ${manifest.completeness}`)
  console.log(`  sessions:       ${manifest.sessions.length}`)
  for (const s of manifest.sessions) {
    const sid = s.sessionId ? s.sessionId.slice(0, 16) : "(none)"
    console.log(`    - ${s.agentLabel} | ses=${sid} | replayed=${s.replayed} | integrity=${s.outputIntegrity} | events=${s.eventCount}`)
  }
  check("V-6: completeness = full", manifest.completeness === "full", `actual: ${manifest.completeness}`)
  check("V-10: manifest 仍写入（不论 completeness）", manifest.status !== undefined)
  check("runAttemptId 非空", !!manifest.runAttemptId)
}
console.log()

// ============================================================
// 2. traces/
// ============================================================
console.log("=== 2. traces/ ===")
const tracesDir = path.join(runDir, "traces")
if (!fs.existsSync(tracesDir)) {
  check("traces/ 目录存在", false)
} else {
  const traceFiles = fs.readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"))
  check("traces/ 目录存在", true, `${traceFiles.length} 个 trace 文件`)
  for (const f of traceFiles) {
    const content = fs.readFileSync(path.join(tracesDir, f), "utf8")
    const lines = content.split("\n").filter((l) => l.trim())
    if (lines.length === 0) {
      console.log(`  ${f}: 空（0 events）`)
      continue
    }
    const first = JSON.parse(lines[0])
    const tools = lines.map((l) => JSON.parse(l).tool).filter(Boolean)
    console.log(`  ${f}: ${lines.length} events, tools=[${tools.join(", ")}]`)
    check(`  trace ${f.slice(0, 12)}... 含工具事件`, lines.length > 0)
    check(`  trace ${f.slice(0, 12)}... input 不为空`, !!first.input && Object.keys(first.input).length > 0)
  }
}
console.log()

// ============================================================
// 3. history.jsonl
// ============================================================
console.log("=== 3. history.jsonl ===")
const jsonlPath = path.join(runDir, "history.jsonl")
if (!fs.existsSync(jsonlPath)) {
  check("history.jsonl 存在", false)
} else {
  const jsonl = fs.readFileSync(jsonlPath, "utf8")
  if (!jsonl.trim()) {
    check("history.jsonl 非空", false, "文件为空")
  } else {
    const events = jsonl
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    check("history.jsonl 存在且非空", true, `${events.length} events`)

    // 按类型统计
    const byType = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1
      return acc
    }, {} as Record<string, number>)
    console.log(`  按类型: ${JSON.stringify(byType)}`)

    // V-7: 按时间排序
    let sorted = true
    for (let i = 1; i < events.length; i++) {
      if (events[i].ts < events[i - 1].ts) {
        sorted = false
        break
      }
    }
    check("V-7: 事件按时间戳排序", sorted)

    // 含工具调用
    const toolCalls = events.filter((e) => e.type === "tool_call")
    check("V-7: 含 tool_call 事件", toolCalls.length > 0, `${toolCalls.length} 个`)
    if (toolCalls.length > 0) {
      console.log("  工具调用序列:")
      for (const tc of toolCalls) {
        console.log(`    ${tc.ts} | ${tc.agentLabel} | ${tc.tool} [${tc.status}]`)
      }
    }

    // 含 workflow_start/end（执行树）
    const wfStarts = events.filter((e) => e.type === "workflow_start")
    const wfEnds = events.filter((e) => e.type === "workflow_end")
    check("含 workflow_start 事件", wfStarts.length > 0, `${wfStarts.length} 个`)
    check("含 workflow_end 事件", wfEnds.length > 0, `${wfEnds.length} 个`)

    // 含 agent_start/end
    const agentStarts = events.filter((e) => e.type === "agent_start")
    check("含 agent_start 事件", agentStarts.length > 0, `${agentStarts.length} 个`)
  }
}
console.log()

// ============================================================
// 4. history.md
// ============================================================
console.log("=== 4. history.md ===")
const mdPath = path.join(runDir, "history.md")
if (!fs.existsSync(mdPath)) {
  check("history.md 存在", false)
} else {
  const md = fs.readFileSync(mdPath, "utf8")
  if (!md.trim()) {
    check("history.md 非空", false, "文件为空")
  } else {
    check("history.md 存在且非空", true, `${md.length} 字符`)
    check("V-8: 含标题", md.includes("# Workflow History:"))
    check("V-8: 含执行树段", md.includes("## Execution Tree"))
    check("V-8: 含工具序列段", md.includes("## Tool Call Sequence"))
    console.log()
    console.log("--- history.md 全文 ---")
    console.log(md)
  }
}
console.log()

// ============================================================
// 总结
// ============================================================
console.log("=== 验证总结 ===")
console.log(`通过: ${pass}  失败: ${fail}`)
if (fail === 0) {
  console.log("[全部通过] P1 History 落盘验证成功")
} else {
  console.log(`[部分失败] ${fail} 项未通过，请检查上方标记`)
}
process.exit(fail > 0 ? 1 : 0)
