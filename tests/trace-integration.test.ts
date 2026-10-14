/**
 * P0-B 真实集成测试：验证 session.messages() 返回完整 ToolPart
 *
 * 跳过条件：未设置 OPENCODE_TEST_BASE_URL 环境变量时跳过
 * （CI 默认跳过，本地手动运行验证）
 *
 * 三个必须回答的问题：
 *  1. 真实 session.messages 返回的 ToolPart 是否含完整 state.input
 *  2. 一次 prompt 是否产生多条 Assistant 消息，全部 ToolPart 可遍历
 *  3. Agent 被 abort 后已产生的 ToolPart 是否仍可读取
 *
 * 运行方式：
 *   set OPENCODE_TEST_BASE_URL=http://localhost:4096
 *   npx tsx --test tests/trace-integration.test.ts
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const BASE_URL = process.env.OPENCODE_TEST_BASE_URL
const SKIP = !BASE_URL

/** 创建真实 SDK client（连 OpenCode 服务端） */
async function makeClient() {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  return createOpencodeClient({ baseUrl: BASE_URL! })
}

/** 临时项目目录 */
function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-trace-"))
}

test("真实 Agent 执行 read write bash 后 session.messages 返回完整 ToolPart", { skip: SKIP }, async () => {
  const client = await makeClient()
  const dir = tmpProject()
  // 写一个测试文件供 Agent 读取
  fs.writeFileSync(path.join(dir, "data.txt"), "hello world\n")

  // 创建会话
  const created = await client.session.create({ body: { title: "trace-test" } })
  if (created.error) throw new Error(`session create 失败: ${JSON.stringify(created.error)}`)
  const sessionId = created.data.id

  // 发送 prompt：让 Agent 读文件、写脚本、运行脚本
  const promptText = [
    `请在工作目录 ${dir} 下完成以下步骤：`,
    `1. 用 read 工具读取 ${path.join(dir, "data.txt")} 的内容`,
    `2. 用 write 工具创建一个 Python 脚本 ${path.join(dir, "echo.py")}，内容为 print("processed: " + open("${path.join(dir, "data.txt")}").read().strip())`,
    `3. 用 bash 工具运行 python ${path.join(dir, "echo.py")}`,
    `完成后简要报告结果。`,
  ].join("\n")

  const response = await client.session.prompt({
    path: { id: sessionId },
    body: {
      agent: "general",
      parts: [{ type: "text", text: promptText }],
    },
    query: { directory: dir },
  })

  if (response.error) throw new Error(`session prompt 失败: ${JSON.stringify(response.error)}`)

  // 拉取全部消息
  const messagesResult = await client.session.messages({
    path: { id: sessionId },
    query: { directory: dir },
  })
  if (messagesResult.error) throw new Error(`session.messages 失败: ${JSON.stringify(messagesResult.error)}`)

  const messages = messagesResult.data as Array<{
    info: { id: string; role: string }
    parts: Array<{ type: string; [key: string]: unknown }>
  }>

  // 问题 1：多 Assistant 消息
  const assistantMsgs = messages.filter((m) => m.info.role === "assistant")
  assert.ok(
    assistantMsgs.length >= 2,
    `一次 prompt 产生 ${assistantMsgs.length} 条 Assistant 消息（预期 >= 2）`,
  )

  // 喂给 parseSessionMessages 解析
  const { parseSessionMessages } = await import("../src/trace/collector.js")
  const events = parseSessionMessages(messages as never)

  // 问题 2：全部 ToolPart 提取
  assert.ok(events.length >= 3, `提取 ${events.length} 个工具调用（预期 >= 3：read + write + bash）`)

  // 验证 write 工具的 input.content 含完整脚本内容（不截断）
  const writeEvent = events.find((e) => e.tool === "write")
  assert.ok(writeEvent, "存在 write 工具调用")
  const writeContent = writeEvent!.input.content as string | undefined
  assert.ok(
    typeof writeContent === "string" && writeContent.includes("print("),
    `write 的 input.content 含脚本内容（长度 ${writeContent?.length ?? 0}）`,
  )

  // 验证 bash 工具的 input.command
  const bashEvent = events.find((e) => e.tool === "bash")
  assert.ok(bashEvent, "存在 bash 工具调用")
  const bashCommand = bashEvent!.input.command as string | undefined
  assert.ok(
    typeof bashCommand === "string" && bashCommand.includes("python"),
    `bash 的 input.command 含 python 命令`,
  )

  // 验证 read 工具的 input.filePath
  const readEvent = events.find((e) => e.tool === "read")
  assert.ok(readEvent, "存在 read 工具调用")

  // 只取最后一条消息的 ToolPart，证明不能只取最后一条
  const lastMsgTools = assistantMsgs[assistantMsgs.length - 1].parts.filter(
    (p) => p.type === "tool",
  )
  assert.ok(
    events.length > lastMsgTools.length,
    `全部 ToolPart（${events.length}）多于最后一条消息的（${lastMsgTools.length}），不能只取最后一条`,
  )

  console.log("[P0-B] 工具调用序列:")
  for (const e of events) {
    const inputPreview = JSON.stringify(e.input).slice(0, 80)
    console.log(`  ${e.tool} [${e.status}] input=${inputPreview}`)
  }
})

test("真实 Agent 写入长脚本后 input 不截断", { skip: SKIP }, async () => {
  const client = await makeClient()
  const dir = tmpProject()

  const created = await client.session.create({ body: { title: "trace-long" } })
  if (created.error) throw new Error(`session create 失败: ${JSON.stringify(created.error)}`)
  const sessionId = created.data.id

  // 让 Agent 写一个 100 行的脚本
  const lines = Array.from({ length: 100 }, (_, i) => `print("line ${i}")`).join("\\n")
  const promptText = `用 write 工具创建文件 ${path.join(dir, "long.py")}，内容为：\n${Array.from({ length: 100 }, (_, i) => `print("line ${i}")`).join("\n")}\n完成后报告。`

  const response = await client.session.prompt({
    path: { id: sessionId },
    body: { agent: "general", parts: [{ type: "text", text: promptText }] },
    query: { directory: dir },
  })
  if (response.error) throw new Error(`session prompt 失败: ${JSON.stringify(response.error)}`)

  const messagesResult = await client.session.messages({
    path: { id: sessionId },
    query: { directory: dir },
  })
  const messages = messagesResult.data as Array<{
    info: { id: string; role: string }
    parts: Array<{ type: string; [key: string]: unknown }>
  }>

  const { parseSessionMessages } = await import("../src/trace/collector.js")
  const events = parseSessionMessages(messages as never)

  const writeEvent = events.find((e) => e.tool === "write" && e.status === "completed")
  assert.ok(writeEvent, "存在已完成的 write 调用")
  const content = writeEvent!.input.content as string | undefined
  assert.ok(content, "input.content 存在")
  const lineCount = content!.split("\n").length
  assert.ok(
    lineCount >= 50,
    `100 行脚本不截断，实际 ${lineCount} 行（content 长度 ${content!.length}）`,
  )
  console.log(`[P0-B] 长脚本：${lineCount} 行，${content!.length} 字符，不截断`)
})

test("真实 abort 后 ToolPart 残留可读", { skip: SKIP }, async () => {
  const client = await makeClient()
  const dir = tmpProject()

  const created = await client.session.create({ body: { title: "trace-abort" } })
  if (created.error) throw new Error(`session create 失败: ${JSON.stringify(created.error)}`)
  const sessionId = created.data.id

  // 发送一个会耗时较长的 prompt（让 Agent 执行多步工具）
  const promptText = `在工作目录 ${dir} 下：先用 read 工具读取任意文件，然后用 write 工具创建脚本，再用 bash 运行。每步都报告。`
  const promptPromise = client.session.prompt({
    path: { id: sessionId },
    body: { agent: "general", parts: [{ type: "text", text: promptText }] },
    query: { directory: dir },
  })

  // 等待一小段时间让 Agent开始执行工具，然后 abort
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await client.session.abort({ path: { id: sessionId } }).catch(() => {})

  // 等 prompt 返回（abort 后应该返回）
  await promptPromise.catch(() => {})

  // 拉取消息
  const messagesResult = await client.session.messages({
    path: { id: sessionId },
    query: { directory: dir },
  })
  const messages = messagesResult.data as Array<{
    info: { id: string; role: string }
    parts: Array<{ type: string; [key: string]: unknown }>
  }>

  const { parseSessionMessages } = await import("../src/trace/collector.js")
  const events = parseSessionMessages(messages as never)

  // abort 后应能读到已产生的 ToolPart（可能少于正常完成，但不为空）
  assert.ok(
    events.length > 0,
    `abort 后仍有 ${events.length} 个 ToolPart 残留`,
  )
  // 应含未完成状态的 ToolPart
  const unfinished = events.filter(
    (e) => e.status === "running" || e.status === "pending",
  )
  console.log(
    `[P0-B] abort 后残留：${events.length} 个 ToolPart，其中 ${unfinished.length} 个未完成`,
  )
  // 即使没有未完成的（Agent 恰好在 step 间被中断），至少已完成的部分应保留
  assert.ok(events.length > 0, "已产生的工具调用记录不丢")
})
