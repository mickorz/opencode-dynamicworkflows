**You:**

多模型编排agent详情内容为空问题-注意事项.md

我的opencode-dynamic-workflow遇到 如果设置agent schema结构后，tui无法看到任何内容，只有空白的情况，你帮我看看

* * *

**ChatGPT:**

我看过你这份排查记录，也对照了现在 OpenCode 的实现。**你的根因判断是对的，而且我建议不要继续从模型/prompt 层修，而应该从 `opencode-dynamic-workflow` 的 TUI 展示层修。**

你现在的链路实际上是：

```
agent(..., { schema })
        ↓
opencode-session-adapter
        ↓
format: {
  type: "json_schema",
  schema: ...
}
        ↓
OpenCode StructuredOutput
        ↓
模型通过 tool call 返回 JSON
        ↓
message.info.structured 有数据
assistant.text part 可能完全没有
        ↓
workflow 能正常拿结果
TUI session 正文却是空的
```

这和你文档里的数据库实验完全吻合：带 `schema` 后最终结果走 `StructuredOutput`，而不是普通 assistant text；所以 workflow 没坏，只是你当前 TUI 的“查看 Agent 详情”依赖了错误的数据源。

而且 OpenCode 当前官方 SDK 文档也明确写了：`format: json_schema` 会使用 `StructuredOutput` tool 返回校验后的 JSON，而结构化结果通过 structured output 字段获取。 [GitHub](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx)

### 我建议你这样修

**不要让 Dynamic Workflow 的 Agent 详情页等同于 OpenCode 原始 Session 页面。**

这是这次问题最关键的架构调整。

现在你应该类似这样：

```
Workflow TUI
  │
  ├─ Agent A
  ├─ Agent B
  └─ Agent C
        │
        └─ 点击
             ↓
       route.navigate("session", {
           sessionID
       })
```

于是你完全依赖 OpenCode Session Renderer。

建议改成：

```
Workflow TUI
  │
  └─ Agent C
        │
        └─ 点击
             ↓
       WorkflowNodeDetail
             │
             ├─ Status
             ├─ Agent
             ├─ Model
             ├─ Duration
             ├─ Tokens
             ├─ Prompt
             ├─ Structured Result   ← 关键
             ├─ Error
             └─ Open Session        ← 可选
```

也就是：

```
              ┌───────────────────────┐
              │ Workflow Node Detail  │
              ├───────────────────────┤
              │ DSL LoginUI           │
              │ Status: ✓ completed   │
              │ Model: glm-5.3-flash  │
              │ Duration: 5.2s        │
              │                       │
              │ Result                │
              │ ───────────────────   │
              │ {                     │
              │   "ok": true,         │
              │   "screen": "LoginUI" │
              │ }                     │
              │                       │
              │ [Open raw session]    │
              └───────────────────────┘
```

这样 **schema / 非 schema 的 Agent 在 Workflow TUI 中表现完全一致。**

* * *

### 数据应该从哪里拿？

你目前已经有最合适的数据源：

```
.opencode-workflows/journal/
```

你自己的实验已经证明：

```
journal.result
```

里面保存的是完整结构化结果，即使 assistant `text part = 0` 也不受影响。

所以推荐：

```TypeScript
interface WorkflowNodeDetail {
  id: string
  label: string

  status: "pending" | "running" | "completed" | "failed"

  agent?: string
  model?: string

  sessionId?: string

  prompt?: string

  result?: unknown      // ⭐ schema structured result
  error?: string

  startedAt?: number
  completedAt?: number

  tokens?: {
    input?: number
    output?: number
  }
}
```

然后 TUI：

```TypeScript
<Show when={node.result}>
  <box flexDirection="column">
    <text>Result</text>

    <text>
      {formatResult(node.result)}
    </text>
  </box>
</Show>
```

最简单的：

```TypeScript
function formatResult(result: unknown) {
  if (typeof result === "string") {
    return result
  }

  return JSON.stringify(result, null, 2)
}
```

* * *

### 我反而不建议“往 Session 里人工补 text part”

表面看可以这样解决：

```
StructuredOutput
      ↓
拿到 result
      ↓
再人工插入 assistant text
      ↓
TUI 就能看到
```

例如伪代码：

```TypeScript
const structured = message.info.structured

await appendAssistantText(
  sessionId,
  JSON.stringify(structured, null, 2)
)
```

我不建议。

因为它会造成语义污染：

```
真实模型输出：

assistant
 ├─ reasoning
 └─ tool: StructuredOutput

被插件修改以后：

assistant
 ├─ reasoning
 ├─ tool: StructuredOutput
 └─ text: {...}       ← 插件伪造
```

后面 OpenCode 如果：

```
继续对话
fork session
压缩 context
重新读取 history
```

这个 synthetic text 就可能重新进入模型上下文。

**为了 UI 展示去修改 Agent 历史记录，是比较危险的。**

* * *

### 也不要为了 TUI 去掉 schema

你现在 schema 的设计其实是正确的：

```JavaScript
const result = await agent(prompt, {
    schema: {
        type: "object",
        properties: {
            ok: { type: "boolean" },
            workspace: { type: "string" }
        },
        required: ["ok"]
    }
})

if (result.ok) {
   ...
}
```

相比：

```JavaScript
const text = await agent(prompt)

const result = JSON.parse(text)
```

前者明显更适合 Dynamic Workflow。

你文档里也已经证明：

> schema 的字段契约、类型校验和 workflow 后续字段访问都工作正常。

所以不能因为 UI 看不到内容，把执行层降级成文本 JSON。

* * *

### 还有一个很重要的 OpenCode 限制

我查了一下当前 OpenCode TUI。

它的 Tool Renderer 目前仍然主要是：

```
ToolPart
   ↓
Switch / Match
   ↓
Builtin Renderer
   ↓
GenericTool
```

而且有人专门提过 **“允许插件给 Tool Call 注册自定义 TUI renderer”** 的 feature request；目前该 issue 已经被关闭为 `not planned`。也就是说，目前并没有一个稳定的官方插件 API，让你的插件直接告诉 OpenCode：

```TypeScript
registerRenderer("StructuredOutput", MyRenderer)
```

来优雅地覆盖宿主 Session 页面。 [GitHub](https://github.com/anomalyco/opencode/issues/33302)

所以我更不建议你去硬改：

```
OpenCode Session TUI
```

而是：

```
Dynamic Workflow TUI
        ↓
自己负责 Workflow Node Detail
```

这是边界最干净的方案。

* * *

我会把你的方案从原来：

```
Workflow Node
     ↓
OpenCode Session
     ↓
读取 assistant text
```

升级成：

```
                    ┌─ normal text ─────────┐
Agent ─ Adapter ────┤                      │
                    └─ structured result ──┤
                                           ↓
                                   Workflow Journal
                                           ↓
                                    Workflow Node
                                           ↓
                                  Node Detail Renderer
                                    │             │
                                    │             └─ Result
                                    │
                                    └─ Open Raw Session
```

这样以后不只是 `schema`，包括 Agent 返回：

```
JSON
文本
文件路径
测试报告
Lint Result
UI DSL Result
多 Agent 并行结果
error
```

你的 Dynamic Workflow TUI 都可以统一展示。

**所以我建议把这次问题定义为：**

> `opencode-dynamic-workflow` 当前把“Workflow Node Result”和“OpenCode Session Transcript”错误地当成了同一个东西。

而真正应该拆成：

```
Session Transcript = Agent 怎么执行的
Workflow Result    = Agent 最后产生了什么
```

这两个本来就是不同概念。

如果只做第一版，我建议你现在直接实现 **`Node Detail -> journal.result`**，保留一个 `Open Session` 操作查看原始 Agent 执行过程。这是改动最小、长期架构也最合理的一版。

* * *

**You:**

在详细一点介绍这个方案，并说明可能遇到的问题，要注意的问题

* * *

**ChatGPT:**

可以。你现在这个问题，最好不要理解成“怎么让 schema Agent 在原生 Session 里显示文字”，而是把它当成一次 **Dynamic Workflow TUI 架构分层问题** 来解决。

你现在已经验证：`schema` 会让 Agent 结果进入 `StructuredOutput`，workflow 变量和 journal 里的结果都是完整的，但 assistant 可能根本没有 `text part`，所以原生 Session 正文为空。

我建议最终做成下面这个结构。

* * *

# 一、先明确现在的问题到底在哪里

当前实际上有三种不同的数据：

```
1. Agent Session Transcript
   Agent 在执行过程中说了什么、调了什么工具

2. Agent Result
   Agent 最终给 Workflow 返回什么

3. Workflow Node State
   这个节点是否成功、耗时多少、用了哪个模型、对应哪个 session
```

你现在的 TUI 实际上把：

```
Agent Result
```

错误地等同于：

```
Session Transcript
```

所以点击：

```
DSL LoginUI
```

实际上做的是：

```TypeScript
route.navigate({
  type: "session",
  sessionID
})
```

于是画面由 OpenCode 自己的 Session TUI 负责。

对于普通 Agent：

```
assistant text
↓
TUI 能看到

"我完成了 LoginUI DSL 的创建……"
```

所以没问题。

但是 schema Agent：

```
assistant
 ├ reasoning
 ├ tool: StructuredOutput
 └ 没有 text
```

最终数据可能是：

```JSON
{
  "ok": true,
  "screen_name": "LoginUI",
  "node_count": 37
}
```

但它存在：

```
message.info.structured
或者
StructuredOutput tool input
或者
workflow result
或者
journal.result
```

而不是：

```
assistant text
```

所以原生 Session 页面没有正文，这完全符合你数据库里的实验结果。

* * *

# 二、正确架构：Node Detail 和 Session Detail 分离

我建议把现在：

```
Workflow
   │
   └── Node
          │
          └── Session
```

改成：

```
Workflow
   │
   └── Node
          │
          ├── Workflow Node Detail
          │       │
          │       ├── Result
          │       ├── Status
          │       ├── Model
          │       ├── Token
          │       ├── Duration
          │       ├── Input
          │       └── Error
          │
          └── Open Raw Session
                  │
                  ├── reasoning
                  ├── tools
                  ├── text
                  └── StructuredOutput
```

这两个页面承担完全不同的职责。

**Node Detail：**

> 这个任务做出了什么结果？

**Raw Session：**

> 这个 Agent 是怎么执行这个任务的？

这个分离非常重要。

比如以后你的 workflow 是：

```JavaScript
const spec = await agent(...)

const dsl = await agent(...)

const lint = await agent(...)

const review = await agent(...)
```

用户真正关心的是：

```
spec 产生了什么
dsl 产生了什么
lint 结果是什么
review 得到什么结论
```

而不一定关心：

```
模型调用了几次 read
模型调用了几次 bash
模型推理过程中说了什么
```

所以 Workflow UI 本身就应该有自己的 Result 层。

* * *

# 三、推荐的数据流

不要让 TUI 自己去猜：

```
assistant text 是不是 result
```

应该让 Workflow Runtime 明确告诉 TUI：

```
这个 Node 的 result 是什么。
```

我建议数据链路变成：

```
agent()
   │
   ▼
OpenCodeSessionAdapter
   │
   ├── text mode
   │       ↓
   │    promptText()
   │       ↓
   │      string
   │
   └── schema mode
           ↓
      promptStructured()
           ↓
      structured object
           │
           ▼
        AgentResult
           │
           ▼
     Workflow Runtime
           │
     ┌─────┴──────┐
     ▼            ▼
Node Runtime     Journal
State
     │
     └────────┐
              ▼
        Workflow TUI
              │
         Node Detail
```

关键是：

```
TUI 不再去 Session 里解析 Result。
```

Result 是 Workflow Runtime 的一等数据。

* * *

# 四、Node 数据结构建议

你现在可以正式给 Workflow Node 定义一个执行结果结构。

比如：

```TypeScript
interface WorkflowNodeExecution {
  id: string

  // workflow
  runId: string
  nodeId: string
  label: string

  // execution
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"

  // agent
  agentType?: string
  model?: string
  sessionId?: string

  // input
  prompt?: string

  // output
  output?: {
    type:
      | "text"
      | "structured"
      | "unknown"

    value: unknown
  }

  // error
  error?: {
    message: string
    stack?: string
  }

  // timing
  startedAt?: number
  completedAt?: number

  // usage
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
  }
}
```

这样：

普通 Agent：

```JSON
{
  "output": {
    "type": "text",
    "value": "LoginUI DSL 已创建完成"
  }
}
```

schema Agent：

```JSON
{
  "output": {
    "type": "structured",
    "value": {
      "ok": true,
      "screen_name": "LoginUI",
      "node_count": 37
    }
  }
}
```

TUI 根本不需要关心：

```
这个 JSON 到底来自 assistant text，
还是 StructuredOutput。
```

这是 Adapter 的责任。

* * *

# 五、Adapter 应该负责“统一结果”

这层尤其重要。

你现在应该类似有：

```TypeScript
promptText()

promptStructured()
```

建议最后统一包装：

```TypeScript
type AgentExecutionResult =
  | {
      type: "text"
      value: string
      sessionId: string
    }
  | {
      type: "structured"
      value: unknown
      sessionId: string
    }
```

比如：

```TypeScript
async executeAgent(
  ...
): Promise<AgentExecutionResult> {

  if (options.schema) {
    const result = await this.promptStructured(...)

    return {
      type: "structured",
      value: result,
      sessionId
    }
  }

  const result = await this.promptText(...)

  return {
    type: "text",
    value: result,
    sessionId
  }
}
```

但是这里有一个兼容性问题。

你现在 workflow 用户代码很可能已经写：

```JavaScript
const result = await agent(...)

if (result.ok) {
}
```

所以**不要直接把公开 API 改成：**

```JavaScript
result.value.ok
```

否则是 breaking change。

因此应该是：

```
Plugin Runtime 内部：
AgentExecutionResult

Workflow Script 对外：
仍然返回原来的 value
```

也就是：

```TypeScript
const execution = await adapter.execute(...)

// 给 runtime
recordNodeResult(execution)

// 给用户 JS
return execution.value
```

这样：

```JavaScript
const result = await agent(...)
```

仍然保持：

```JavaScript
result.ok
```

不需要修改已有 workflow。

这点我认为非常重要。

* * *

# 六、Journal 应该怎么设计

你现在的 journal 已经证明非常有价值。

你自己的排查已经确认：

```
快照：status 正常
journal：result 完整
session DB：text part 可能为空
```

也就是说，journal 实际上比 Session Transcript 更适合作为 Workflow 的事实记录。

但我不建议每次用户点一个 Node，都这样：

```
打开 journal 文件
↓
读取整个 JSON
↓
遍历所有 entry
↓
找到对应 node
↓
render
```

小 workflow 看不出问题。

以后如果：

```
50 agents
100 agents
500 journal entries
```

点击节点就会越来越慢。

更合理的是：

```
运行期间：

WorkflowRuntime
     │
     ├── nodeState Map
     │
     └── journal persistence
```

例如：

```TypeScript
Map<string, WorkflowNodeExecution>
```

key 可以用：

```
runId + executionId
```

TUI：

```
优先：
runtime node state

如果 workflow 已结束/恢复历史：
journal
```

也就是：

```
LIVE RUN
    ↓
memory state
    ↓
TUI

RESTORED RUN
    ↓
journal
    ↓
reconstruct state
    ↓
TUI
```

这种结构会比“TUI 直接读文件”健康很多。

* * *

# 七、一定要有 executionId，不能只用 label

这是很容易踩的坑。

例如：

```JavaScript
await parallel(
  files.map(file =>
    () => agent(`分析 ${file}`, {
      label: "代码审查"
    })
  )
)
```

可能产生：

```
代码审查
代码审查
代码审查
代码审查
```

如果 journal 用：

```
label
```

找结果就会冲突。

甚至 nodeId 都不一定足够。

因为：

```
retry
```

以后可能出现：

```
Node A
  execution 1 failed

Node A
  execution 2 success
```

所以建议：

```
runId
nodeId
executionId
sessionId
```

分开。

例如：

```
run-mtux5828-1
node-dsl-login
exec-00017
ses_xxxxxx
```

其中：

```
nodeId
```

表示：

> workflow 图上的逻辑节点。

而：

```
executionId
```

表示：

> 这一次真正执行。

这会为以后：

```
retry
resume
replay
parallel
```

提前解决很多问题。

* * *

# 八、Node Detail 页面建议

第一版不要做得太复杂。

我建议：

```
┌─────────────────────────────────────────────┐
│ DSL LoginUI                         ✓ Done  │
│                                             │
│ Agent       general                         │
│ Model       glm-5.3-flash                   │
│ Duration    4.8s                            │
│ Session     ses_xxxxx                       │
│                                             │
├─────────────────────────────────────────────┤
│ Result                                      │
│                                             │
│ {                                           │
│   "ok": true,                               │
│   "screen_name": "LoginUI",                 │
│   "node_count": 37,                         │
│   "output_path": ".../LoginUI.json"         │
│ }                                           │
│                                             │
├─────────────────────────────────────────────┤
│ [Open Session]        [Copy Result]          │
└─────────────────────────────────────────────┘
```

以后再做：

```
Result
Input
Session
Metadata
```

几个 Tab。

第一版实际上：

```
Header
Result
Open Session
```

就够解决你现在的问题。

* * *

# 九、Result Renderer 要单独抽象

不要直接到处：

```TypeScript
JSON.stringify(result, null, 2)
```

最好从第一版就抽：

```TypeScript
<ResultView result={node.output} />
```

内部：

```TypeScript
switch (result.type) {

  case "text":
    return <TextResult />

  case "structured":
    return <JsonResult />

  default:
    return <RawResult />
}
```

为什么？

因为你的 dynamic workflow 后面极有可能出现：

```
string
JSON
array
boolean
null
超长 Markdown
文件列表
测试结果
lint result
UI spec
```

例如：

```JSON
[
  {
    "file": "LoginUI.ts",
    "errors": 3
  },
  {
    "file": "MainUI.ts",
    "errors": 0
  }
]
```

以后可以给 Array 做：

```
table renderer
```

甚至：

```
file result
```

可以显示：

```
📄 LoginUI.json
📄 LoginUI.fgui
```

所以现在抽这一层成本非常低，但以后很好扩展。

* * *

# 十、最大的问题：Result 可能非常大

这是我认为实现时最需要防范的问题之一。

比如 Agent 返回：

```JSON
{
  "files": [...500 items...],
  "components": [...1000 items...],
  "analysis": "几十 KB"
}
```

如果直接：

```TypeScript
JSON.stringify(result, null, 2)
```

再丢进 TUI：

可能出现：

```
TUI 卡顿
大量内存
滚动困难
甚至 renderer 崩掉
```

所以建议 Result 从第一版就设置：

```
preview
```

例如：

```TypeScript
const MAX_PREVIEW = 20_000
```

如果：

```
JSON.stringify(result).length > MAX_PREVIEW
```

显示：

```
Result

{
  "screens": [
    ...
  ]

───────────────────────────

Result truncated
47 KB total

[View full result]
```

不要默认渲染无限内容。

* * *

# 十一、Result 中可能有敏感内容

这个也非常重要。

workflow result 以后可能包括：

```
API Key
环境变量
服务器地址
数据库 DSN
用户数据
内部路径
```

Session 本来可能没有直接显示出来，但是你如果把：

```
journal.result
```

全部直接显示到 UI，就可能把敏感数据暴露。

建议至少预留：

```TypeScript
redactResult()
```

例如：

```TypeScript
const SECRET_KEYS = [
  "api_key",
  "apikey",
  "token",
  "password",
  "secret",
  "authorization"
]
```

输出：

```JSON
{
  "api_key": "***",
  "password": "***"
}
```

甚至最好设计成：

```
TUI Preview
≠
raw journal
```

因为：

```
journal
```

属于机器数据，

而：

```
preview
```

属于用户展示数据。

* * *

# 十二、Journal 不一定永远有 Result

目前你的 schema Agent 有：

```
journal.result
```

非常正常。

但需要防：

```
Agent running
Agent crash
OpenCode process 被 kill
插件 crash
JSON 写了一半
用户 Ctrl+C
```

此时可能只有：

```JSON
{
  "status": "running"
}
```

没有：

```
result
```

因此 UI 不能简单写：

```TypeScript
JSON.stringify(node.result)
```

应该区分：

```
running

No result yet
```

和：

```
completed

No result returned
```

以及：

```
failed

Error:
xxxx
```

三个完全不同的状态。

* * *

# 十三、Journal 写入必须考虑原子性

比如你保存：

```
run.json
```

过程中程序突然退出：

```
{
  "nodes": [
     ...
```

只写了一半。

下一次启动：

```TypeScript
JSON.parse()
```

直接失败。

比较稳的方式是：

```
run.json.tmp
    ↓
完整写入
    ↓
fsync / close
    ↓
rename
    ↓
run.json
```

或者采用：

```
JSONL append-only journal
```

例如：

```JSON
{"type":"node_started","executionId":"1"}
{"type":"node_completed","executionId":"1","result":{...}}
{"type":"node_started","executionId":"2"}
```

append-only 对 Workflow Runtime 通常非常合适。

你现在叫：

```
journal
```

如果本身就是 append/event log 思路，那么这条路线其实挺好。

* * *

# 十四、Parallel 是另一个重点

你的插件核心卖点之一就是：

```JavaScript
parallel(...)
```

那就一定要考虑：

```
Agent A
Agent B
Agent C
Agent D
```

同时运行。

不能共享：

```TypeScript
currentResult
```

这种全局状态。

而应该：

```TypeScript
resultsByExecutionId
```

例如：

```TypeScript
Map<
  ExecutionId,
  WorkflowNodeExecution
>
```

事件：

```
agent A start
agent B start
agent C start
agent B complete
agent A complete
agent C fail
```

TUI 必须正确更新：

```
A ✓
B ✓
C ✗
```

不能依赖：

```
执行完成顺序 == workflow 定义顺序
```

因为 parallel 下这显然不成立。

* * *

# 十五、Retry 会进一步放大这个问题

以后你很可能支持：

```JavaScript
agent(..., {
  retry: 3
})
```

Node Detail 最终可能需要：

```
DSL LoginUI

Attempt 1    ❌
Attempt 2    ❌
Attempt 3    ✓
```

所以不要把：

```
node result
```

直接覆盖掉历史 execution。

应该：

```
Node
  │
  ├ Execution 1
  ├ Execution 2
  └ Execution 3
```

第一版可以只显示：

```
latest execution
```

但是底层 ID 设计最好现在就支持多个 execution。

* * *

# 十六、Session 仍然应该保留

新的 Node Detail 不是为了替代 Session。

而是：

```
Node Detail
    │
    │ 结果不对？
    ▼
Open Session
    │
    ▼
看模型执行过程
```

比如：

```
Result:
{
  "ok": false
}
```

用户想知道：

> 为什么失败？

点：

```
Open Session
```

进去看：

```
read
bash
reasoning
StructuredOutput
```

这两个功能是互补的。

所以我强烈建议不要删除现在已有的：

```TypeScript
route.navigate("session")
```

而是把它从：

> 点击 Node 默认行为

降成：

> Node Detail 里的辅助行为。

* * *

# 十七、不要给 assistant 人工补一条 text

这个方案看起来诱人：

```
StructuredOutput
      ↓
{
 "ok": true
}
      ↓
自动添加：
assistant text:
"{ \"ok\": true }"
```

这样原始 Session 马上就不空了。

但是副作用非常大。

因为 Session History 是模型上下文的一部分。

以后可能：

```
continue
fork
compact
resume
```

那么你人工产生的：

```
assistant text
```

可能重新进入模型上下文。

这样 UI 层开始污染推理层。

所以原则最好是：

```
Execution data 不改
Session data 不改
只改变 Presentation
```

* * *

# 十八、不要用 Prompt 强迫模型说一句话

你的实验已经把这条路基本否掉。

你甚至已经测试：

```
调用 StructuredOutput 前必须先输出正文
```

flash 仍然可以：

```
0 text part
```

所以：

```
prompt workaround
```

既不可靠，还浪费 token。

不要再在这里投入时间。

* * *

# 十九、不要因为 UI 问题移除 Schema

这更不应该。

你的 Workflow 正是需要：

```
结构化结果
```

才能稳定编排。

比如：

```JavaScript
const result = await agent(..., {
  schema: INIT_SCHEMA
})

if (!result.ok) {
   throw ...
}

const workDir = result.work_dir
```

schema 可以保证：

```
ok:boolean
work_dir:string
```

而不是期待模型输出：

````
```json
...
````

````

再自己：

```js
JSON.parse()
````

你的文档也确认结构化结果完全正常，并且 workflow 后续字段访问正常。

所以这里应该坚持：

```
Schema = Execution Contract
```

而不是：

```
Schema = UI Format
```

* * *

# 二十、OpenCode TUI 本身还有一个现实限制

目前 OpenCode TUI 的插件扩展能力仍然不是完全开放的。2026 年已经有人明确提出，希望插件能注册自己的 Tool Renderer；相关 issue 指出 TUI 的工具渲染目前主要还是硬编码分发，插件工具会落到 GenericTool，而不是拥有类似 Web UI 的完整自定义 renderer。 [GitHub+1](https://github.com/anomalyco/opencode/issues/21018?utm_source=chatgpt.com)

所以：

```
我给 StructuredOutput 注入自己的 renderer
```

目前并不是一条特别稳定的插件路线。

这也是为什么我更推荐：

```
Workflow 自己的 Route
+
Workflow 自己的 Node Detail
```

而不是：

```
魔改原生 Session Renderer
```

OpenCode 社区甚至有人提出“让插件拥有 session projection / notice / custom view 等更细的 TUI 扩展点”，其动机就是避免插件整个复制或替换原生 Session UI，因为那样非常容易随着宿主更新漂移。 [GitHub](https://github.com/anomalyco/opencode/issues/26043?utm_source=chatgpt.com)

* * *

# 二十一、OpenCode 升级兼容性也必须考虑

这对你的插件尤其重要。

你的代码如果大量依赖：

```
OpenCode 内部 TUI implementation
packages/tui/src/...
private component
private route shape
```

OpenCode 一升级，很容易：

```
1.18.x ✓
1.19.x ✗
```

甚至当前 OpenCode 的 TUI 插件生态已经出现过因为 `@opentui/solid` 实例/renderer context 不匹配导致整个 TUI 崩溃的问题。 [GitHub](https://github.com/anomalyco/opencode/issues/27447?utm_source=chatgpt.com)

所以最好建立一条边界：

```
OpenCode integration layer
           │
           ▼
Dynamic Workflow Runtime
           │
           ▼
Dynamic Workflow UI
```

尽量只让：

```
OpenCode integration layer
```

感知 OpenCode 的版本差异。

不要让：

```
Workflow runtime
Node model
Journal
Result renderer
```

都依赖 OpenCode 内部实现。

* * *

# 二十二、StructuredOutput 自己也不是绝对稳定的

这个问题与你现在的空白问题不同，但值得提前防。

截至 2026 年 9 月，OpenCode 仍有新 issue 报告某些 Anthropic 新模型在 `json_schema` structured output 路径上，因为 `tool_choice: required` 的兼容问题直接返回 400。 [GitHub](https://github.com/anomalyco/opencode/issues/46735?utm_source=chatgpt.com)

这意味着以后 Node Detail 最好能区分：

```
Workflow Error
Provider Error
Structured Output Error
Schema Validation Error
Agent Error
```

而不是全部显示：

```
Agent failed
```

例如：

```
DSL LoginUI                       ✗ Failed

Type
Structured Output Error

Model
claude-xxx

Message
Provider rejected required tool choice.

[Open Session]
```

这样你的插件会越来越像真正的 Workflow Debugger。

* * *

# 二十三、建议你最终把 Result 定义成一等公民

最终架构我建议确定成：

```
                    OpenCode
                       │
                 Agent Session
                       │
                       ▼
                  ┌─────────┐
                  │ Adapter │
                  └────┬────┘
                       │
             normalized result
                       │
              ┌────────▼────────┐
              │ Workflow Runtime│
              └──────┬───┬──────┘
                     │   │
              runtime│   │journal
                     │   │
                     ▼   ▼
                Workflow State
                     │
                     ▼
                Workflow TUI
                     │
              ┌──────┴───────┐
              │              │
              ▼              ▼
          Node Detail    Open Session
              │              │
              ▼              ▼
            Result        Transcript
```

一句话就是：

> **Workflow Result 归 Dynamic Workflow 管；Agent Transcript 归 OpenCode Session 管。**

这个边界一旦定下来，你现在的 schema 空白问题自然消失，而且以后大量功能都会变得很好加。

* * *

# 二十四、我建议第一版只做这些

先不要马上做成一个完整 Workflow IDE。第一版控制范围：

* 给每次 `agent()` 生成唯一 `executionId`。
* Runtime 保存 `sessionId + status + result + model + timing`。
* journal 持久化相同的 execution 数据。
* TUI 点击 Node 后进入自己的 `NodeDetail`。
* `NodeDetail` 优先展示 `result`，JSON 自动 pretty-print。
* 超长结果默认截断。
* 没有 result 时根据 `running / failed / completed` 正确显示状态。
* NodeDetail 保留 `Open Session`，跳转到原来的 OpenCode Session。
* **不修改 assistant message，不修改 schema，不改现有 `agent()` 返回 API。**

这一版完成之后，你这次：

```
有 schema
↓
TUI 空白
```

的问题实际上就彻底解决了。

而且最重要的是，它不是：

> “为了 GLM Flash 写的特殊补丁”。

而是正式增加了：

> **Workflow Result Inspector**

我认为这个能力甚至可以直接作为你 `opencode-dynamic-workflows` 下一版比较重要的功能点：

```
Workflow Node Inspector

✓ Structured output visualization
✓ Agent execution metadata
✓ Result inspection
✓ Raw session navigation
✓ Schema-friendly agent debugging
```

从插件定位上，也比“修复 schema 空白”更有价值。

* * *

**You:**

再补充一下 开发完如何做abtest

* * *

**ChatGPT:**

可以。这个功能开发完之后，A/B Test 不应该只验证“现在能不能看到 JSON”，而应该验证两件事：

1. **新 Node Detail 确实解决 schema Agent 的空白问题。**
2. **它没有破坏原来无 schema、并行、失败、恢复、Session 跳转等已有能力。**

你之前其实已经做了一次很好的基准实验：同任务、同 prompt，只改变 `schema` 和模型，证明 `schema` 是空白现象的核心变量。  
开发完成后，我建议沿用这个思路，把它升级成一套正式的 **UI A/B + Runtime Regression Test**。

* * *

## 一、A/B Test 的核心定义

这次 A/B 最好定义为：

```
A = 当前旧版本
    Workflow Node
        ↓
    OpenCode Session
        ↓
    assistant text

B = 新版本
    Workflow Node
        ↓
    Node Detail
        ↓
    Workflow Result
        ↓
    可选 Open Session
```

不要定义成：

```
A = glm-5.2
B = glm-5.3-flash
```

模型不是这次真正测试对象。

真正测试的是：

```
旧展示路径
vs
新展示路径
```

模型和 schema 只是测试维度。

* * *

# 二、第一层：最关键的 2×2 A/B Test

先复刻你之前已经验证过的 2×2 实验。

使用：

```
模型：
M1 = bf-glm-5.3-flash
M2 = glm-5.2

输出：
S1 = schema
S2 = no schema
```

得到：

| Case | Model | Schema | 预期旧 TUI | 预期新 Node Detail |
| --- | --- | --- | --- | --- |
| A1 | flash | 有 | 可能空白 | 必须显示 Result |
| A2 | flash | 无 | 有正文 | 必须显示 Result |
| B1 | 5.2 | 有 | 可能只有过程文字 | 必须显示 Result |
| B2 | 5.2 | 无 | 有正文 | 必须显示 Result |

这里最重要的是：

```
A1
flash + schema
```

这是你目前稳定复现 bug 的基准组。

你原来的实验已经证明 A1 的 assistant text 可以是 0，但 StructuredOutput 和 workflow result 都存在。

开发后必须满足：

```
Old UI:

A1
Node → Session
Result ❌ 不可见


New UI:

A1
Node → Node Detail
Result ✅ 可见

Open Session
仍然可以看到原始 session
```

这就是最直接的 A/B 成功标准。

* * *

# 三、建议直接保留原来的测试任务

不要重新设计一个复杂测试任务。

使用你原来这种轻量任务最好：

```
读取 opencode.json
并返回简单总结。
```

schema：

```JavaScript
const TEST_SCHEMA = {
  type: "object",
  properties: {
    ok: {
      type: "boolean"
    },
    summary: {
      type: "string"
    },
    file_count: {
      type: "number"
    }
  },
  required: [
    "ok",
    "summary"
  ]
}
```

Agent：

```JavaScript
const result = await agent(
  `
读取当前项目的 opencode.json。

返回：
- 是否读取成功
- 两三句总结
- 如果可以的话返回发现的配置数量
  `,
  {
    agentType: "general",
    label: "AB Test - Flash Schema",
    model: "biangfeng-gateway/bf-glm-5.3-flash",
    schema: TEST_SCHEMA
  }
)
```

因为这个任务：

```
输入小
执行快
结果稳定
几乎没有业务逻辑干扰
```

特别适合回归测试。

* * *

# 四、不要只测试“能看到”，还要验证数据一致性

这是新实现最容易漏掉的一点。

你应该同时比对四份数据：

```
1. agent() 返回值
2. Runtime node.result
3. journal.result
4. TUI Node Detail 展示值
```

例如 Agent 返回：

```JSON
{
  "ok": true,
  "summary": "读取成功",
  "file_count": 4
}
```

那么最终应该：

```
agent return
    =
runtime result
    =
journal result
    =
TUI result
```

最好自动比较。

例如：

```TypeScript
assert.deepEqual(
  runtimeResult,
  agentReturn
)

assert.deepEqual(
  journalResult,
  agentReturn
)
```

如果你有 UI 测试能力，再检查 TUI 内容。

最低要求人工检查：

```
TUI 显示：

{
  "ok": true,
  "summary": "读取成功",
  "file_count": 4
}
```

而不是：

```
[object Object]
```

或者：

```
undefined
```

* * *

# 五、建议增加一个专门的 AB Test workflow

直接在插件工程里留下：

```
examples/
或者
tests/workflows/
```

例如：

```
tests/workflows/
  node-detail-ab-test.js
```

内容类似：

```JavaScript
const MODEL_FLASH =
  "biangfeng-gateway/bf-glm-5.3-flash"

const MODEL_STRONG =
  "biangfeng-gateway/glm-5.2"


const TEST_SCHEMA = {
  type: "object",
  properties: {
    ok: {
      type: "boolean"
    },

    summary: {
      type: "string"
    },

    source: {
      type: "string"
    }
  },

  required: [
    "ok",
    "summary",
    "source"
  ]
}


const prompt = `
读取 opencode.json。

只需要简单分析。

返回：
ok
summary
source
`


const results = await parallel([

  () => agent(prompt, {
    label: "A1 Flash Schema",
    model: MODEL_FLASH,
    schema: TEST_SCHEMA
  }),

  () => agent(prompt, {
    label: "A2 Flash Text",
    model: MODEL_FLASH
  }),

  () => agent(prompt, {
    label: "B1 GLM Schema",
    model: MODEL_STRONG,
    schema: TEST_SCHEMA
  }),

  () => agent(prompt, {
    label: "B2 GLM Text",
    model: MODEL_STRONG
  })

])


console.log(results)
```

以后每次你修改：

```
Adapter
Runtime
Journal
TUI
schema
agent()
parallel()
```

都可以跑一次。

这个文件不要删。

它实际上会成为你的：

> Structured Output Regression Test

* * *

# 六、第二层：schema / no-schema 的兼容测试

Node Detail 不应该只解决 schema。

因为以后点击普通 Agent：

```JavaScript
const result = await agent("分析 README")
```

result 是：

```
string
```

而 schema Agent：

```JavaScript
const result = await agent(..., {
  schema
})
```

result 是：

```
object
```

所以至少测试：

```
Case 1
string

Case 2
object

Case 3
array

Case 4
boolean

Case 5
null / undefined
```

例如：

```
Text Result

分析完成，README 中包含……
```

和：

```
Structured Result

{
  "ok": true
}
```

都应该正常。

* * *

# 七、第三层：测试 Result 大小

这个我建议一定做。

分别测试：

```
Small
1 KB

Medium
20 KB

Large
100 KB+

Very Large
1 MB
```

特别是你的 UI / DSL 工作流，以后非常容易返回：

```
几十 KB JSON
```

测试：

```
large-result-test.js
```

例如生成：

```JavaScript
return {
  components: Array.from(
    { length: 2000 },
    (_, i) => ({
      id: i,
      name: `Component-${i}`,
      x: i,
      y: i
    })
  )
}
```

验证：

```
Node Detail 打开是否立即响应

滚动是否流畅

是否发生 TUI 卡死

truncate 是否工作

Full Result 是否还能访问
```

成功标准可以直接定：

```
< 20 KB
完整显示

20 KB+
默认截断

显示：
Result truncated
Original size: xxx KB
```

不要等以后真的遇到大 JSON 才处理。

* * *

# 八、第四层：Parallel A/B Test

这是你的插件非常重要的一项。

例如：

```JavaScript
await parallel([
  () => agent(...),
  () => agent(...),
  () => agent(...),
  () => agent(...)
])
```

建议测试至少：

```
20 个 agent
```

并且 label 故意重复：

```
分析文件
分析文件
分析文件
分析文件
```

目的是验证你没有偷偷使用：

```
label
```

作为 Result 的唯一索引。

正确结果应该：

```
Node
executionId 001 → Result A

Node
executionId 002 → Result B

Node
executionId 003 → Result C
```

不能出现：

```
点 Agent A
看到 Agent B 的结果
```

这类问题在并行状态下非常常见。

* * *

# 九、专门做一个“乱序完成”实验

Parallel 最好增加：

```
Agent A sleep 5s
Agent B sleep 1s
Agent C sleep 3s
```

最终完成顺序：

```
B
C
A
```

但是 TUI 顺序：

```
A
B
C
```

仍然按照 workflow 定义顺序。

点击：

```
A → Result A

B → Result B

C → Result C
```

这能验证：

```
你是根据 executionId 更新状态
```

而不是：

```
按照 results.push() 顺序更新
```

后者非常容易产生错位。

* * *

# 十、第五层：失败 Agent Test

需要主动制造失败。

例如：

```JavaScript
await agent(`
读取一个绝对不存在的文件：
Z:/__not_exist__/abc.json

如果失败直接返回错误。
`)
```

或者 schema 不满足。

你要验证 Node Detail：

```
✗ Failed

Error

File not found
```

而不是：

```
Result

undefined
```

更不能：

```
TUI crash
```

建议测试：

```
normal failure

provider failure

schema validation failure

tool failure
```

第一版至少确保所有失败最终能落到：

```
status = failed
error != null
```

* * *

# 十一、第六层：运行中状态

不要只测试：

```
任务完成之后点击
```

还要测试：

```
Agent 正在运行的时候点击。
```

例如 Agent 执行 20 秒。

这时候：

```
Node Detail

Status
Running

Result
No result yet

Session
ses_xxxxxx

[Open Session]
```

而不是：

```
Result:
undefined
```

等运行完成以后：

```
Running
↓
Completed
```

Node Detail 应该自动更新。

如果必须退回上一级再打开才能刷新，就说明你的状态订阅还有问题。

* * *

# 十二、第七层：Session 跳转回归测试

你开发这个 Node Detail 最容易无意破坏的是：

```
原来的 Open Session
```

所以 A/B 要验证：

旧版：

```
Node
↓
直接进入 Session
```

新版：

```
Node
↓
Node Detail
↓
Open Session
↓
相同 sessionID
```

验证：

```
sessionId 完全相同
```

不能因为 NodeDetail 新增了一层，产生新的 Session。

尤其检查：

```
before:
ses_abc123

after:
ses_abc123
```

必须一致。

* * *

# 十三、第八层：Restart / History Test

这个很容易开发时漏掉。

实时运行的时候：

```
Runtime memory
```

有 Result。

但关闭 OpenCode：

```
exit
```

重新进入：

```
opencode
```

Runtime memory 全没了。

这时候应该：

```
journal
↓
restore node state
↓
Node Detail
```

再打开之前执行完成的 workflow：

```
Result 仍然能够看到。
```

所以测试流程：

```
Step 1
运行 workflow

Step 2
确认 Result

Step 3
完全关闭 OpenCode

Step 4
重新启动 OpenCode

Step 5
打开历史 workflow

Step 6
点击同一 node

Step 7
检查 Result
```

如果这一步失败：

```
实时能看
历史不能看
```

说明你的 Node Detail 过度依赖 runtime memory。

* * *

# 十四、Journal 恢复测试

可以进一步故意：

```
运行完成
↓
关闭程序
↓
检查 journal
```

确认：

```JSON
{
  "executionId": "...",
  "sessionId": "...",
  "status": "completed",
  "result": {
    ...
  }
}
```

然后让 UI 只从 journal 重建。

这一步尤其重要，因为你自己的实验已经证明 journal 中结构化结果目前是完整的。

* * *

# 十五、第九层：Retry Test

如果现在已经支持 retry 就直接测；没支持的话，可以把它作为预留测试。

模拟：

```
Attempt 1
Fail

Attempt 2
Success
```

底层应该：

```
node-01
 ├ exec-01 Failed
 └ exec-02 Completed
```

TUI 第一版可以只显示：

```
最新结果
```

但必须确认：

```
exec-01
```

没有覆盖：

```
exec-02
```

或者反过来。

* * *

# 十六、第十层：敏感数据测试

测试 Result：

```JSON
{
  "api_key": "sk-test-123",
  "token": "abcdef",
  "password": "123456",
  "project": "test"
}
```

Node Detail 应该：

```JSON
{
  "api_key": "***",
  "token": "***",
  "password": "***",
  "project": "test"
}
```

尤其如果以后这个插件给其他人使用，这个问题迟早会出现。

* * *

# 十七、最终推荐测试矩阵

我建议你最终保留大约这 12 个 Case：

| ID | Case | 核心验证 |
| --- | --- | --- |
| T01 | Flash + Schema | 修复原始空白问题 |
| T02 | Flash + No Schema | 普通文本兼容 |
| T03 | GLM + Schema | 跨模型结构化输出 |
| T04 | GLM + No Schema | 普通 Session |
| T05 | Large Result | 截断与性能 |
| T06 | Parallel ×20 | 并发 Result 映射 |
| T07 | Parallel 乱序完成 | executionId 正确 |
| T08 | Agent Failed | Error UI |
| T09 | Running Agent | 实时更新 |
| T10 | Restart | journal 恢复 |
| T11 | Open Session | sessionID 不变 |
| T12 | Duplicate Label | label 不作为唯一 key |

如果这些通过，你这版基本就比较稳了。

* * *

# 十八、建议做一个自动测试报告

你之前测试权限插件时已经采用过“Agent 自动跑完 → 保存报告”的方式，这个项目也很适合。

建议生成：

```
.opencode-workflows/
  test-reports/
    node-detail-ab-test-2026-09-10.json
```

结构：

```JSON
{
  "test": "Workflow Node Detail AB Test",

  "plugin_version": "0.3.0",

  "cases": [
    {
      "id": "T01",
      "name": "Flash + Schema",

      "expected": {
        "status": "completed",
        "result_visible": true
      },

      "actual": {
        "status": "completed",
        "runtime_result": true,
        "journal_result": true,
        "assistant_text_parts": 0,
        "node_detail_result": true
      },

      "passed": true
    }
  ]
}
```

这样以后：

```
0.3.0
0.3.1
0.4.0
```

每次发布前都可以跑。

* * *

# 十九、甚至可以把原来的“空白”保留成黄金测试

这一点非常重要。

不要尝试把：

```
assistant text parts = 0
```

变成：

```
assistant text parts > 0
```

因为你这次新的正确行为应该是：

```
schema Agent：

assistant text parts = 0        ← 可以正常
StructuredOutput exists = true
workflow result exists = true
journal result exists = true
Node Detail result visible = true
```

这才是 **PASS**。

换句话说：

```
原始 Session 依然可以是空白的。
```

你的新功能并不是修 OpenCode Session。

而是在 Dynamic Workflow 层正确展示：

```
Workflow Result
```

这是 A/B Test 中非常容易搞错的验收目标。

* * *

# 二十、我建议最后定一个明确的 Release Gate

以后发布 `opencode-dynamic-workflows` 新版本之前：

```
npm test
↓
unit test

npm run test:workflow
↓
runtime tests

npm run test:node-detail
↓
12 个 Node Detail Cases

npm run test:ab
↓
2×2 schema/model test
```

最终：

```
Node Detail Test
────────────────────

T01 Flash Schema          PASS
T02 Flash Text            PASS
T03 GLM Schema            PASS
T04 GLM Text              PASS
T05 Large Result          PASS
T06 Parallel              PASS
T07 Out-of-order          PASS
T08 Failure               PASS
T09 Live Update           PASS
T10 Restore               PASS
T11 Open Session          PASS
T12 Duplicate Label       PASS

12 / 12 PASS

Release Gate: PASS
```

尤其 **T01：Flash + schema + assistant text = 0 + Node Detail result 可见**，我建议以后永远保留。

因为它就是这次 bug 的最小复现，也是防止未来重构 Adapter/TUI 后这个问题再次回来的最佳回归测试。你原来的 2×2 实验已经给这个测试提供了非常好的基线。

如果你接下来让 AI/Claude Code 实际开发，我建议直接把这套测试也一起作为需求交给它：**功能开发完成不算完成，12 个 Case 全部生成测试报告后才算完成。**这样会比“先开发、然后人工点几下看看”可靠很多。