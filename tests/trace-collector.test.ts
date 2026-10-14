/**
 * Trace Collector 单元测试（P0-A）
 *
 * 验证 parseSessionMessages 解析能力：
 *  - 多消息多工具：全部 ToolPart 提取，不漏最后一条
 *  - callID 状态流转：pending -> completed 两条都保留
 *  - 失败工具：input 和 error 都提取
 *  - 中断残留：pending/running 状态也提取
 *  - 非 tool Part 跳过
 *  - 空消息不报错
 *  - dedupeByCallID：折叠为每个 callID 的最终态
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  parseSessionMessages,
  dedupeByCallID,
  type RawSessionMessage,
} from "../src/trace/collector.js"

test("单消息单工具：基本提取 tool 名 callID input output status", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "config.json" },
            output: '{"key": "value"}',
            metadata: { outputPath: "/tmp/trunc/xxx" },
            time: { start: 1000, end: 1100 },
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  const e = events[0]
  assert.equal(e.tool, "read")
  assert.equal(e.callID, "call-1")
  assert.equal(e.status, "completed")
  assert.deepEqual(e.input, { filePath: "config.json" })
  assert.equal(e.output, '{"key": "value"}')
  assert.deepEqual(e.metadata, { outputPath: "/tmp/trunc/xxx" })
  assert.equal(e.startedAt, 1000)
  assert.equal(e.endedAt, 1100)
  assert.equal(e.messageID, "msg-1")
  assert.equal(e.partID, "prt-1")
  assert.equal(e.messageIndex, 0)
  assert.equal(e.partIndex, 0)
})

test("多消息多工具：全部 ToolPart 提取不漏最后一条", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "user" },
      parts: [{ type: "text", text: "请读取文件并修复" }],
    },
    {
      info: { id: "msg-2", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-1",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "config.json" },
            output: "{}",
            time: { start: 1000, end: 1100 },
          },
        },
      ],
    },
    {
      info: { id: "msg-3", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-2",
          callID: "call-2",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "fix.py", content: "print('hello')" },
            output: "写入成功",
            time: { start: 1200, end: 1300 },
          },
        },
      ],
    },
    {
      info: { id: "msg-4", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-3",
          callID: "call-3",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "python fix.py" },
            output: "修复完成",
            time: { start: 1400, end: 1500 },
          },
        },
      ],
    },
    {
      info: { id: "msg-5", role: "assistant" },
      parts: [{ type: "text", text: "任务完成" }],
    },
  ]

  const events = parseSessionMessages(messages)
  assert.equal(events.length, 3, "提取三个 ToolPart（read + write + bash）")
  assert.equal(events[0].tool, "read")
  assert.equal(events[1].tool, "write")
  assert.equal(events[2].tool, "bash")
  // 顺序按 messageIndex
  assert.ok(events[0].messageIndex < events[1].messageIndex)
  assert.ok(events[1].messageIndex < events[2].messageIndex)
  // write 的 input.content 含完整脚本（不截断）
  assert.equal(events[1].input.content, "print('hello')")
  // bash 的 input.command 含完整命令
  assert.equal(events[2].input.command, "python fix.py")
})

test("callID 状态流转：pending 与 completed 都保留", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1a",
          callID: "call-x",
          tool: "write",
          state: { status: "pending", input: {} },
        },
        {
          type: "tool",
          id: "prt-1b",
          callID: "call-x",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "fix.py", content: "print('hello')" },
            output: "写入成功",
            time: { start: 100, end: 200 },
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 2, "pending + completed 两条都保留")
  assert.equal(events[0].status, "pending")
  assert.equal(events[1].status, "completed")
  assert.equal(events[0].callID, events[1].callID, "同一 callID")
})

test("失败工具：input 和 error 都提取", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-err",
          tool: "bash",
          state: {
            status: "error",
            input: { command: "python broken.py" },
            error: "SyntaxError: invalid syntax",
            time: { start: 100, end: 150 },
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "error")
  assert.deepEqual(events[0].input, { command: "python broken.py" })
  assert.equal(events[0].error, "SyntaxError: invalid syntax")
})

test("中断残留：running 状态的 ToolPart 也提取", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-abort",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "long-task" },
            time: { start: 1000 },
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "running")
  assert.deepEqual(events[0].input, { command: "long-task" })
  assert.equal(events[0].endedAt, undefined, "running 态无结束时间")
})

test("非 tool Part 跳过", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        { type: "text", text: "分析中" },
        {
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        {
          type: "tool",
          id: "prt-1",
          callID: "c1",
          tool: "read",
          state: { status: "completed", input: { filePath: "a.txt" } },
        },
        { type: "reasoning", text: "思考中" },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1, "只提取 tool Part")
  assert.equal(events[0].tool, "read")
  assert.equal(events[0].partIndex, 2, "partIndex 反映在原始 parts 中的位置")
})

test("空消息不报错", () => {
  assert.deepEqual(parseSessionMessages([]), [])
  assert.deepEqual(
    parseSessionMessages([{ info: { id: "m", role: "user" }, parts: [] }]),
    [],
  )
})

test("单消息多工具：按 partIndex 排序", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "c1",
          tool: "read",
          state: { status: "completed", input: {} },
        },
        {
          type: "tool",
          id: "p2",
          callID: "c2",
          tool: "write",
          state: { status: "completed", input: {} },
        },
        {
          type: "tool",
          id: "p3",
          callID: "c3",
          tool: "bash",
          state: { status: "completed", input: {} },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 3)
  assert.deepEqual(
    events.map((e) => e.tool),
    ["read", "write", "bash"],
    "按 partIndex 顺序",
  )
  assert.deepEqual(
    events.map((e) => e.partIndex),
    [0, 1, 2],
  )
})

test("dedupeByCallID：折叠为每个 callID 的最终态", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "c1",
          tool: "write",
          state: { status: "pending", input: {} },
        },
        {
          type: "tool",
          id: "p2",
          callID: "c1",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "x.py", content: "print(1)" },
            output: "ok",
          },
        },
        {
          type: "tool",
          id: "p3",
          callID: "c2",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" } },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 3, "原始三条（含 pending）")

  const deduped = dedupeByCallID(events)
  assert.equal(deduped.length, 2, "折叠为两个 callID")
  const write = deduped.find((e) => e.callID === "c1")!
  assert.equal(write.status, "completed", "取最终态 completed 而非 pending")
  assert.equal(write.input.content, "print(1)")
  const bash = deduped.find((e) => e.callID === "c2")!
  assert.equal(bash.status, "completed")
})

test("write 工具 input 含完整脚本内容（不截断）", () => {
  // 模拟一个 500 行的脚本
  const longScript = Array.from({ length: 500 }, (_, i) => `print(${i})`).join("\n")
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "c1",
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "big.py", content: longScript },
            output: "写入成功",
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  assert.equal(events[0].input.content, longScript, "完整脚本内容不截断")
  assert.equal(
    (events[0].input.content as string).split("\n").length,
    500,
    "500 行全部保留",
  )
})

test("bash heredoc 脚本：command 含完整脚本内容", () => {
  const heredocCommand = `cat > fix.py <<'EOF'\nimport sys\nprint("hello")\nprint(sys.argv[1])\nEOF\npython fix.py arg1`
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "p1",
          callID: "c1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: heredocCommand },
            output: "hello\narg1",
          },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  assert.equal(events[0].input.command, heredocCommand, "完整命令不截断")
  assert.ok(
    (events[0].input.command as string).includes("cat > fix.py"),
    "含 heredoc 创建脚本",
  )
})
