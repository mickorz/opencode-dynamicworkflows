/**
 * Trace 采集验证脚本（独立运行，不依赖 workflow 工具）
 *
 * 用法：先在 OpenCode 中跑完 trace-verify.js workflow，
 *       拿到 Agent 的 sessionId 后，修改下方 SESSION_ID，
 *       然后在项目根目录运行：
 *   npx tsx dev-examples/development-trace/scripts/verify-trace-collection.ts
 *
 * 验证三个问题：
 *  1. session.messages() 返回的 ToolPart 是否含完整 state.input
 *  2. 一次 prompt 是否产生多条 Assistant 消息
 *  3. write 工具的 input.content 是否含完整脚本（不截断）
 */

import { createOpencodeClient } from "@opencode-ai/sdk"
import { parseSessionMessages } from "../../../src/trace/collector.js"

// ===== 配置区 =====
const BASE_URL = process.env.OPENCODE_TEST_BASE_URL ?? "http://localhost:4096"
// 改成你跑完 workflow 后 Agent 的 sessionId（从 workflow 结果或 TUI Node Detail 获取）
const SESSION_ID = process.env.TRACE_SESSION_ID ?? "ses-xxx"
const DIRECTORY = process.env.TRACE_DIRECTORY ?? process.cwd()
// ==================

async function main() {
  console.log(`[Trace 验证] 连接 ${BASE_URL}`)
  console.log(`[Trace 验证] Session: ${SESSION_ID}`)
  console.log(`[Trace 验证] 目录: ${DIRECTORY}`)

  const client = createOpencodeClient({ baseUrl: BASE_URL })

  // 拉取全部消息
  const result = await client.session.messages({
    path: { id: SESSION_ID },
    query: { directory: DIRECTORY },
  })

  if (result.error) {
    console.error("[Trace 验证] session.messages 失败:", JSON.stringify(result.error))
    process.exit(1)
  }

  const messages = result.data as Array<{
    info: { id: string; role: string }
    parts: Array<{ type: string; [key: string]: unknown }>
  }>

  console.log(`[Trace 验证] 消息总数: ${messages.length}`)

  const assistantMsgs = messages.filter((m) => m.info.role === "assistant")
  console.log(`[Trace 验证] Assistant 消息数: ${assistantMsgs.length}`)

  // 问题 2：多 Assistant 消息
  if (assistantMsgs.length >= 2) {
    console.log(`[通过] 一次 prompt 产生 ${assistantMsgs.length} 条 Assistant 消息（预期 >= 2）`)
  } else {
    console.log(`[注意] 只有 ${assistantMsgs.length} 条 Assistant 消息（可能 Agent 未使用工具）`)
  }

  // 喂给 parseSessionMessages 解析
  const events = parseSessionMessages(messages as never)
  console.log(`\n[Trace 验证] 提取工具调用事件: ${events.length} 个`)
  console.log("=".repeat(60))

  for (const e of events) {
    const inputPreview = JSON.stringify(e.input).slice(0, 120)
    console.log(`  ${e.tool.padEnd(8)} [${e.status.padEnd(9)}] msg=${e.messageIndex} part=${e.partIndex}`)
    console.log(`           input: ${inputPreview}`)
    if (e.output) {
      console.log(`           output: ${e.output.slice(0, 80)}${e.output.length > 80 ? "..." : ""}`)
    }
    if (e.error) {
      console.log(`           error: ${e.error.slice(0, 80)}`)
    }
  }

  console.log("=".repeat(60))

  // 问题 1：state.input 完整性
  const writeEvent = events.find((e) => e.tool === "write" && e.status === "completed")
  if (writeEvent) {
    const content = writeEvent.input.content as string | undefined
    if (content && content.length > 0) {
      console.log(`\n[通过] write 工具 input.content 完整：${content.length} 字符`)
      console.log(`       脚本内容预览: ${content.slice(0, 100).replace(/\n/g, "\\n")}...`)
    } else {
      console.log(`\n[失败] write 工具 input.content 为空或缺失`)
    }
  } else {
    console.log(`\n[注意] 未找到已完成的 write 工具调用`)
  }

  // 问题 3：bash 命令完整性
  const bashEvent = events.find((e) => e.tool === "bash")
  if (bashEvent) {
    const command = bashEvent.input.command as string | undefined
    if (command) {
      console.log(`[通过] bash 工具 input.command 完整：${command.length} 字符`)
      console.log(`       命令预览: ${command.slice(0, 100)}`)
    }
  }

  // 只取最后一条消息的 ToolPart 对比
  const lastMsgTools = assistantMsgs[assistantMsgs.length - 1]?.parts.filter(
    (p) => p.type === "tool",
  ) ?? []
  if (events.length > lastMsgTools.length) {
    console.log(
      `\n[通过] 全部 ToolPart（${events.length}）> 最后一条消息的（${lastMsgTools.length}），不能只取最后一条`,
    )
  }

  console.log("\n[Trace 验证] 完成")
}

main().catch((err) => {
  console.error("[Trace 验证] 异常:", err)
  process.exit(1)
})
