# P0 执行文档 - Development Trace 采集验证

> 本文件是 Development Trace & History 功能 P0 阶段的详细执行计划。
> 基线：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`，仓库 v0.11.2。
>
> P0 目标：验证 Trace 采集的技术可行性 + 修复 Composite 身份冲突 Bug。
> P0 不产出生产功能，只产出测试证据与最小解析模块。

## 类头流程图：P0 执行顺序

```
 P0 执行顺序与依赖关系

 P0 附带 Composite 身份冲突修正
        |
        | 独立提交独立测试
        v
 P0-A Mock 单元测试
   验证 parseSessionMessages 解析能力
        |
        | 无外部依赖可立即开始
        v
 P0-B 真实集成测试
   验证真实 OpenCode 返回完整 ToolPart
        |
        | 需可用 OpenCode 实例
        v
 P0 验收判定
   全部断言通过则进入 P1
```

## 一、P0 范围与交付物

| 子项 | 内容 | 依赖 | 交付物 |
|------|------|------|--------|
| P0 附带 | Composite 身份冲突修正 | 无 | 代码改动 + 测试 |
| P0-A | Mock 单元测试 | 新建 `src/trace/collector.ts` | 测试文件 + 最小解析模块 |
| P0-B | 真实集成测试 | 可用的 OpenCode 实例 | 集成测试脚本 + 测试报告 |

P0 完成后不进入 P1，除非以下三个问题全部有答案：
1. 真实 `session.messages()` 返回的 ToolPart 是否含完整 `state.input`
2. 一次 prompt 是否产生多条 Assistant 消息，全部 ToolPart 是否可遍历采集
3. Agent 被 abort 后已产生的 ToolPart 是否仍可读取

## 二、P0 附带：Composite 身份冲突修正

### 2.1 问题定位

`CompositeRecord.id` 在每个 WorkflowScope 内从 `cmp0` 开始计数（`workflow-runtime.ts:928`）。但所有 scope 的 CompositeRecord 推入同一个 `shared.composites` 数组（`workflow-runtime.ts:940`）。前台和后台的进度收集代码只按裸 `id` 字符串匹配：

- `src/tools/workflow.ts:237-240`：
  ```typescript
  const index = progressComposites.findIndex((c) => c.id === record.id)
  if (index >= 0) progressComposites[index] = record
  else progressComposites.push(record)
  ```

- `src/tools/background-runs.ts:207-210`：
  ```typescript
  const index = info.composites.findIndex((c) => c.id === record.id)
  if (index >= 0) info.composites[index] = record
  else info.composites.push(record)
  ```

当两个兄弟子 Workflow（经 `parallel()` 并发）各执行一个 `sequence/fallback/race` 时，二者都产生 `cmp0`，推入同一数组后，`onCompositeUpdate` 更新第二个时会错误命中第一个。

### 2.2 修改方案

CompositeRecord 已携带 `scopePath`（所属 Workflow scope 链）和 `compositePath`（组合链含自身），二者组合在整 run 内唯一。新增匹配键函数：

```typescript
// 匹配键：scopePath + compositePath 拼接，整 run 内唯一
function compositeMatchKey(record: CompositeRecord): string {
  return record.scopePath.join(":") + ":" + record.compositePath.join(":")
}
```

修改两处进度收集代码，将 `c.id === record.id` 改为 `compositeMatchKey(c) === compositeMatchKey(record)`。

### 2.3 具体改动

**文件 1：`src/tools/workflow.ts`**

在 `onCompositeUpdate` 回调中（约 237 行），将匹配逻辑改为：

```typescript
onCompositeUpdate: (record) => {
  const key = record.scopePath.join(":") + ":" + record.compositePath.join(":")
  const index = progressComposites.findIndex((c) =>
    c.scopePath.join(":") + ":" + c.compositePath.join(":") === key
  )
  if (index >= 0) progressComposites[index] = record
  else progressComposites.push(record)
},
```

**文件 2：`src/tools/background-runs.ts`**

在 `onCompositeUpdate` 回调中（约 207 行），同样改法：

```typescript
onCompositeUpdate: (record) => {
  const key = record.scopePath.join(":") + ":" + record.compositePath.join(":")
  const index = info.composites.findIndex((c) =>
    c.scopePath.join(":") + ":" + c.compositePath.join(":") === key
  )
  if (index >= 0) info.composites[index] = record
  else info.composites.push(record)
},
```

### 2.4 测试用例

**新建测试文件：`tests/composite-collision.test.ts`**

```typescript
/**
 * Composite 身份冲突测试：并行兄弟子 Workflow 各含组合节点时
 * 进度收集不因 cmpN 重名而错误覆盖
 */
```

测试场景：父 Workflow 经 `parallel()` 同时调用两个子 Workflow，每个子 Workflow 内各执行一个 `sequence()`。验证：

| 断言 | 说明 |
|------|------|
| `result.composites.length === 2` | 两个组合节点都在结果中 |
| 两个 composite 的 `scopePath` 不同 | 分别为 `["root","wf0"]` 和 `["root","wf1"]` |
| 两个 composite 的 `id` 相同（都是 `cmp0`） | 重名是冲突的前提 |
| `onCompositeUpdate` 回调中两条 record 都被正确更新 | 不互相覆盖 |

测试结构参考现有 `tests/workflow-observability.test.ts` 的 `makeRunner` / `tmpProject` / `put` 模式。用 `onCompositeUpdate` 回调收集 record，断言两条都被推入且终态正确。

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runWorkflow } from "../src/runtime/workflow-runtime.js"
import type { AgentSessionRunner } from "../src/agent/session-runner.js"
import type { CompositeRecord } from "../src/types/index.js"

function makeRunner(): AgentSessionRunner {
  return {
    async run(prompt) {
      return { value: `ok:${prompt.slice(0, 8)}`, sessionId: "s1", type: "text" }
    },
  }
}

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-cmp-coll-"))
}

test("并行兄弟子 Workflow 各含 sequence：cmpN 重名不冲突", async () => {
  const dir = tmpProject()
  // 子 Workflow：各含一个 sequence
  fs.writeFileSync(
    path.join(dir, "child.js"),
    `export const meta = { name: 'child' }\n` +
    `const r = await sequence([() => agent('a'), () => agent('b')])\n` +
    `return r`,
  )
  const parent =
    `export const meta = { name: 'parent' }\n` +
    `return (await parallel([\n` +
    `  () => workflow('./child.js'),\n` +
    `  () => workflow('./child.js'),\n` +
    `])).length`

  const collected: CompositeRecord[] = []
  const result = await runWorkflow(parent, {
    agent: makeRunner(),
    cwd: dir,
    onCompositeUpdate: (record) => {
      const key = record.scopePath.join(":") + ":" + record.compositePath.join(":")
      const index = collected.findIndex(
        (c) => c.scopePath.join(":") + ":" + c.compositePath.join(":") === key,
      )
      if (index >= 0) collected[index] = record
      else collected.push(record)
    },
  })

  // 两个组合节点都在结果中
  assert.equal(result.composites.length, 2, "两个 sequence 各一个 composite")
  // 重名前提
  const ids = result.composites.map((c) => c.id)
  assert.deepEqual(ids, ["cmp0", "cmp0"], "兄弟 scope 的 cmpN 重名")
  // scopePath 不同
  const scopePaths = result.composites.map((c) => c.scopePath.join(":"))
  assert.deepEqual(scopePaths.sort(), ["root:wf0", "root:wf1"])
  // 回调收集的两条终态都正确
  assert.equal(collected.length, 2, "回调不被重名覆盖")
  assert.ok(collected.every((c) => c.status === "ok"), "两条都到达终态")
})
```

### 2.5 验证命令

```bash
npm run typecheck
npx tsx --test tests/composite-collision.test.ts
npm test
```

## 三、P0-A：Mock 单元测试

### 3.1 目标

验证 `parseSessionMessages()` 纯函数能正确解析 `session.messages()` 返回的原始数据，提取全部 ToolPart，按 callID 去重，按消息与 Part 顺序排列。

P0-A 不需要真实 OpenCode，用构造的固定数据验证解析逻辑。

### 3.2 新建最小解析模块

**新建文件：`src/trace/collector.ts`**

这是 P0 的最小骨架，只含解析函数，不含存储、不含 SDK 依赖。

```typescript
/**
 * Trace Collector —— session.messages() 返回值的解析层（P0 最小版）
 *
 * 职责：把 session.messages() 返回的原始消息数组解析为
 *       有序的工具调用事件序列，供 History Builder 消费。
 *
 * 纯函数，无 SDK 依赖，无 IO。宿主无关。
 * OpenCodeSessionAdapter 负责调 session.messages() 拿原始数据，
 * 本模块只消费结构化输入。
 */

/** 单次工具调用事件（从 ToolPart 提取） */
export interface ToolCallEvent {
  /** 工具调用的逻辑身份（同一调用的 pending->running->completed 共享 callID） */
  callID: string
  /** 工具名（write / bash / edit / read 等） */
  tool: string
  /** 所属消息 ID */
  messageID: string
  /** Part ID */
  partID: string
  /** 工具状态 */
  status: "pending" | "running" | "completed" | "error"
  /** 完整工具入参（不截断） */
  input: Record<string, unknown>
  /** 截断后的输出预览（仅 completed/error 有） */
  output?: string
  /** 错误信息（仅 error 有） */
  error?: string
  /** 元数据（含 outputPath 指向磁盘全文） */
  metadata?: Record<string, unknown>
  /** 开始时间戳（毫秒） */
  startedAt?: number
  /** 结束时间戳（毫秒） */
  endedAt?: number
  /** 在消息中的序号（用于还原顺序） */
  partIndex: number
  /** 所属消息在全部消息中的序号 */
  messageIndex: number
}

/** session.messages() 返回的原始消息形状（与 OpenCode SDK 一致） */
export interface RawSessionMessage {
  info: {
    id: string
    role: "user" | "assistant"
  }
  parts: Array<{
    type: string
    id?: string
    callID?: string
    tool?: string
    state?: {
      status?: string
      input?: Record<string, unknown>
      output?: string
      error?: string
      metadata?: Record<string, unknown>
      time?: { start?: number; end?: number }
    }
  }>
}

/**
 * 解析 session.messages() 返回值，提取有序工具调用事件。
 *
 * 遍历全部消息（不只 Assistant），提取 type === "tool" 的 Part，
 * 按 messageIndex + partIndex 排序，同一 callID 的多个状态都保留
 * （pending -> running -> completed 是同一调用的不同阶段）。
 */
export function parseSessionMessages(messages: RawSessionMessage[]): ToolCallEvent[] {
  const events: ToolCallEvent[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex]
    if (!msg.parts) continue
    for (let partIndex = 0; partIndex < msg.parts.length; partIndex++) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      const state = part.state ?? {}
      events.push({
        callID: part.callID ?? "",
        tool: part.tool ?? "",
        messageID: msg.info.id,
        partID: part.id ?? "",
        status: (state.status as ToolCallEvent["status"]) ?? "pending",
        input: state.input ?? {},
        output: state.output,
        error: state.error,
        metadata: state.metadata,
        startedAt: state.time?.start,
        endedAt: state.time?.end,
        partIndex,
        messageIndex,
      })
    }
  }
  return events
}
```

### 3.3 测试文件

**新建文件：`tests/trace-collector.test.ts`**

测试用例清单：

| 用例 | 验证点 |
|------|--------|
| 单消息单工具 | 基本提取：tool 名、callID、input、output、status |
| 单消息多工具 | 同一消息内多个 ToolPart 按序号排列 |
| 多消息多工具 | 多条 Assistant 消息的 ToolPart 全部提取，不漏最后一条 |
| callID 去重与状态流转 | 同一 callID 的 pending -> completed 两条都保留，按序排列 |
| 失败工具 | ToolStateError 的 input 和 error 都提取 |
| 中断残留 | pending / running 状态的 ToolPart 也提取（abort 后残留） |
| 空消息 | 无 parts 或无 ToolPart 的消息不报错 |
| 非 tool Part 跳过 | text / step-finish 等非 tool Part 不出现在结果中 |

构造数据示例（多消息多工具场景）：

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import { parseSessionMessages, type RawSessionMessage } from "../src/trace/collector.js"

test("多消息多工具：全部 ToolPart 提取，不漏最后一条", () => {
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
            output: '{"key": "value"}',
            metadata: { outputPath: "/tmp/trunc/xxx" },
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
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "python fix.py" },
            output: "修复完成",
            time: { start: 1200, end: 1500 },
          },
        },
      ],
    },
    {
      info: { id: "msg-4", role: "assistant" },
      parts: [{ type: "text", text: "任务完成" }],
    },
  ]

  const events = parseSessionMessages(messages)
  assert.equal(events.length, 2, "提取两个 ToolPart（read + bash）")
  assert.equal(events[0].tool, "read")
  assert.equal(events[0].callID, "call-1")
  assert.deepEqual(events[0].input, { filePath: "config.json" })
  assert.equal(events[1].tool, "bash")
  assert.equal(events[1].callID, "call-2")
  assert.deepEqual(events[1].input, { command: "python fix.py" })
  // 顺序按 messageIndex + partIndex
  assert.ok(events[0].messageIndex < events[1].messageIndex)
})

test("callID 状态流转：pending 与 completed 都保留", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-x",
          tool: "write",
          state: { status: "pending", input: {}, raw: "" },
        },
        {
          type: "tool",
          id: "prt-1",
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

test("中断残留：pending 和 running 状态的 ToolPart 也提取", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          id: "prt-1",
          callID: "call-abort",
          tool: "bash",
          state: { status: "running", input: { command: "long-task" }, time: { start: 1000 } },
        },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "running")
  assert.deepEqual(events[0].input, { command: "long-task" })
})

test("非 tool Part 跳过", () => {
  const messages: RawSessionMessage[] = [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [
        { type: "text", text: "分析中" },
        { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
        { type: "tool", id: "prt-1", callID: "c1", tool: "read", state: { status: "completed", input: {} } },
      ],
    },
  ]
  const events = parseSessionMessages(messages)
  assert.equal(events.length, 1, "只提取 tool Part")
  assert.equal(events[0].tool, "read")
})

test("空消息不报错", () => {
  assert.deepEqual(parseSessionMessages([]), [])
  assert.deepEqual(
    parseSessionMessages([{ info: { id: "m", role: "user" }, parts: [] }]),
    [],
  )
})
```

### 3.4 验证命令

```bash
npm run typecheck
npx tsx --test tests/trace-collector.test.ts
```

## 四、P0-B：真实集成测试

### 4.1 目标

用真实 OpenCode 服务端验证 `session.messages()` 返回的 ToolPart 数据结构是否与 Schema 一致，特别是 `state.input` 是否被完整填充。

P0-B 必须用真实 Agent 执行（非 fake runner），因为 fake runner 不调用 `client.session.prompt()` 和 `client.session.messages()`。

### 4.2 前置条件

| 条件 | 说明 |
|------|------|
| OpenCode 实例 | 本地运行 `opencode` 或指向可访问的服务端 |
| 环境变量 | `OPENCODE_TEST_BASE_URL` 指向服务端地址；缺省跳过测试 |
| Agent 配置 | 服务端有可用的 `general` agent（可执行 read/write/bash/edit 工具） |
| 测试项目目录 | 一个有真实文件可读写的临时目录 |

### 4.3 测试文件

**新建文件：`tests/trace-integration.test.ts`**

```typescript
/**
 * P0-B 真实集成测试：验证 session.messages() 返回完整 ToolPart
 *
 * 跳过条件：未设置 OPENCODE_TEST_BASE_URL 环境变量时跳过
 * （CI 默认跳过，本地手动运行验证）
 */
```

测试结构：

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const BASE_URL = process.env.OPENCODE_TEST_BASE_URL
const SKIP = !BASE_URL

test("真实 Agent 执行工具后 session.messages 返回完整 ToolPart", { skip: SKIP }, async () => {
  // 1. 创建真实 client（直连 OpenCode 服务端）
  // 2. 创建临时项目目录，写入一个测试文件
  // 3. session.create 创建会话
  // 4. session.prompt 发送让 Agent 执行 read -> write -> bash 的指令
  // 5. session.messages 拉取全部消息
  // 6. 喂给 parseSessionMessages 解析
  // 7. 断言
})
```

### 4.4 三个必须回答的问题与断言

**问题 1：工具入参是否完整**

```typescript
// 断言：write 工具的 state.input.content 包含完整脚本内容
const writeEvent = events.find((e) => e.tool === "write")
assert.ok(writeEvent, "存在 write 工具调用")
assert.ok(
  typeof writeEvent.input.content === "string" &&
  writeEvent.input.content.includes("print"),
  "write 的 input.content 含完整脚本内容"
)
```

**问题 2：多 Assistant 消息**

```typescript
// 断言：一次 prompt 产生多条 Assistant 消息
const assistantMsgs = messages.filter((m) => m.info.role === "assistant")
assert.ok(assistantMsgs.length >= 2, "多步工具调用产生多条 Assistant 消息")

// 断言：全部 ToolPart 分布在各条消息中，不只最后一条
const lastMsgTools = assistantMsgs[assistantMsgs.length - 1].parts
  .filter((p) => p.type === "tool")
assert.ok(
  events.length > lastMsgTools.length,
  "不只最后一条消息含 ToolPart"
)
```

**问题 3：中断后残留**

```typescript
// 断言：abort 后 session.messages 仍返回已产生的 ToolPart
// （需在测试中发送 prompt 后立即 abort，再拉取 messages）
const events = parseSessionMessages(messages)
assert.ok(events.length > 0, "中断后仍有 ToolPart 残留")
assert.ok(
  events.some((e) => e.status === "running" || e.status === "pending"),
  "含未完成状态的 ToolPart"
)
```

### 4.5 验证命令

```bash
# 设置环境变量后运行（本地手动验证）
set OPENCODE_TEST_BASE_URL=http://localhost:4096
npx tsx --test tests/trace-integration.test.ts

# CI 默认跳过（未设置环境变量）
npm test
```

## 五、P0-A 与 P0-B 的衔接

P0-A 验证 `parseSessionMessages()` 的解析逻辑（纯函数，无外部依赖）。
P0-B 验证真实 `session.messages()` 返回的数据是否能被 `parseSessionMessages()` 正确解析。

衔接点：P0-B 拿到真实 messages 后，直接喂给 P0-A 的 `parseSessionMessages()`，验证解析结果与预期一致。

```
P0-B 真实 client.session.messages()
        |
        v
  原始 messages 数组
        |
        v
 P0-A parseSessionMessages()  <- 同一个函数
        |
        v
  ToolCallEvent[] 断言
```

如果 P0-B 发现真实返回的数据结构与 P0-A 构造的 fixture 不一致（字段缺失、形状不同），则修正 `parseSessionMessages()` 与 `RawSessionMessage` 类型，再回 P0-A 补测。

## 六、验收标准汇总

| 编号 | 验收项 | 验证方式 |
|------|--------|----------|
| V-1 | Composite 并行兄弟 scope 的 cmpN 重名不冲突 | `tests/composite-collision.test.ts` 通过 |
| V-2 | parseSessionMessages 提取多消息多工具不漏 | `tests/trace-collector.test.ts` 全部通过 |
| V-3 | callID 状态流转两条都保留 | `tests/trace-collector.test.ts` 通过 |
| V-4 | 失败工具 input 和 error 都提取 | `tests/trace-collector.test.ts` 通过 |
| V-5 | 中断残留 pending/running 也提取 | `tests/trace-collector.test.ts` 通过 |
| V-6 | 真实 session.messages 含完整 state.input | `tests/trace-integration.test.ts` 通过（手动） |
| V-7 | 真实多 Assistant 消息全部 ToolPart 可遍历 | `tests/trace-integration.test.ts` 通过（手动） |
| V-8 | 真实 abort 后 ToolPart 残留可读 | `tests/trace-integration.test.ts` 通过（手动） |
| V-9 | 全量测试不回归 | `npm test` 全部通过 |
| V-10 | 类型检查通过 | `npm run typecheck` 通过 |

## 七、执行顺序与提交策略

### 7.1 执行顺序

```
第一步  P0 附带 Composite 修正
        改 workflow.ts + background-runs.ts
        写 composite-collision.test.ts
        npm run typecheck && npm test
        提交
          |
          v
第二步  P0-A Mock 单元测试
        新建 src/trace/collector.ts
        写 trace-collector.test.ts
        npm run typecheck && npx tsx --test tests/trace-collector.test.ts
        提交
          |
          v
第三步  P0-B 真实集成测试（手动验证）
        本地启动 OpenCode
        设置 OPENCODE_TEST_BASE_URL
        运行 trace-integration.test.ts
        记录测试报告
        按真实返回修正 parseSessionMessages 与类型
        提交
```

### 7.2 提交规范

每个子项独立提交，提交信息遵循仓库 conventional commit 风格：

```
fix(tools): composite 进度匹配键改用 scopePath+compositePath 修正兄弟 scope 的 cmpN 冲突
feat(trace): 新增 parseSessionMessages 解析 session.messages 返回的 ToolPart 序列
test(trace): 新增真实集成测试验证 session.messages 返回完整 ToolPart input
```

### 7.3 P0 完成判定

P0 完成的标志：

1. V-1 到 V-5 全部通过（自动化测试，CI 可跑）。
2. V-6 到 V-8 至少手动验证一次并记录结果（附测试输出到提交说明或 dev-docs）。
3. V-9 和 V-10 通过（不回归）。
4. 如果 V-6 到 V-8 中任一失败，暂停 P1 开发，先解决根因（可能是 OpenCode 服务端行为与 Schema 不一致，需确认是服务端 Bug 还是采集逻辑 Bug）。

### 7.4 P0 完成后的产出

- `src/trace/collector.ts`：最小解析模块（纯函数，含 `parseSessionMessages` + `ToolCallEvent` 类型）
- `tests/composite-collision.test.ts`：Composite 冲突回归测试
- `tests/trace-collector.test.ts`：解析逻辑单元测试
- `tests/trace-integration.test.ts`：真实集成测试（默认跳过，手动运行）
- 测试报告：V-6 到 V-8 的真实输出记录

这些产出构成 P1 的基础：P1 的 Trace Store 和 History Builder 将建立在 `parseSessionMessages` 与 `ToolCallEvent` 之上。

## 八、风险与降级方案

| 风险 | 影响 | 降级 |
|------|------|------|
| P0-B 无可用 OpenCode 实例 | 无法验证真实数据 | P0-B 延期，P0-A 先完成并提交；P0-B 在有实例时补验 |
| 真实 state.input 为空或不完整 | 脚本固化分析缺核心证据 | 需确认是服务端 Bug 还是 Schema 误读；若服务端不填 input，改用工具 Hook（tool.execute.before/after）补充采集 |
| abort 后 session 被清理 | 无法读取残留 ToolPart | 改为执行期增量采集（Hook 实时捕获），而非结束后批量拉取 |
| session.messages 分页行为异常 | 长会话漏 ToolPart | 实现完整分页（limit + before 游标循环），P0-B 验证分页边界 |

## 九、引用说明

本执行文档核对的仓库源码位置：

- Composite 节点生成与 shared 数组：`src/runtime/workflow-runtime.ts:920-954`
- 前台进度匹配（需改）：`src/tools/workflow.ts:237-240`
- 后台进度匹配（需改）：`src/tools/background-runs.ts:207-210`
- CompositeRecord 类型（scopePath / compositePath）：`src/types/index.ts:108-121`
- prompt 循环与多 Assistant 消息：`thirdparties/opencode/packages/opencode/src/session/prompt.ts:1081-1201`
- session.messages 实现：`thirdparties/opencode/packages/opencode/src/session/session.ts:828-851`
- ToolPart 与 ToolState schema：`thirdparties/opencode/packages/schema/src/v1/session.ts:259-322`
- 工具输出截断：`thirdparties/opencode/packages/opencode/src/tool/truncate.ts:12-15`
- session.messages openapi 定义：`thirdparties/opencode/packages/sdk/openapi.json:6089-6202`
- 测试模式参考：`tests/helpers.ts`、`tests/composite-node.test.ts`、`tests/workflow-observability.test.ts`、`tests/opencode-session-adapter.test.ts`、`tests/background.test.ts`
- AgentSessionRunner 接口：`src/agent/session-runner.ts`
- OpenCodeSessionAdapter：`src/adapters/opencode-session-adapter.ts`
- v2 评审修订：`dev-docs/planning/新增Workflow追踪分析-评审修订-v2.md`
