**You:**

我想参考QuintinShaw/pi-dynamic-workflows 开发一个opencode支持的插件 相同的功能，帮我分析一下可行性

* * *

**ChatGPT:**

可以，而且我认为**可行性很高**。

如果你的目标是：

> 参考 `pi-dynamic-workflows`，做一个 `opencode-dynamic-workflows` 插件，让 OpenCode 主 Agent 动态生成 JavaScript Workflow，然后由 Workflow 并行创建大量独立 Session/Agent，最后只把汇总结果返回主上下文。

那么我的判断是：

**核心能力可实现度：90%+**  
**做到和 Pi 版本“运行逻辑基本一致”：可行**  
**做到 Pi 版本“UI/交互体验完全一致”：目前比较困难**

更重要的是，OpenCode 的架构其实**非常适合做这个东西**。

* * *

# 一、先看 pi-dynamic-workflows 到底做了什么

这个项目并不只是“开多个 SubAgent”。

它真正做的是：

```
用户
 ↓
Main Agent
 ↓
生成 Workflow JavaScript
 ↓
Workflow Runtime
 ├─ agent()
 ├─ parallel()
 ├─ pipeline()
 ├─ phase()
 ├─ verify()
 └─ judgePanel()
 ↓
动态创建很多独立 Agent Session
 ↓
结果保存在 Workflow JS 变量
 ↓
最终 Synthesizer
 ↓
Main Agent
```

官方 README 现在明确写的是：

```JavaScript
phase('Scan')

const files = await agent(
  'List every route file under src/routes/.'
)

phase('Review')

const findings = await parallel(
  files.split('\n').map(file =>
    () => agent(`Audit ${file}`)
  )
)

phase('Verify')

return await agent(
  'Synthesize:\n' + findings.join('\n')
)
```

并支持最多 **16 个并发、1000 个 total subagents**，同时还提供 model routing、journal resume、worktree isolation、token/cost accounting 和 verification helpers。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)

核心思想就是我们前面讨论 Dynamic Workflow 时说的：

```
Main Context
     │
     │  workflow script
     ▼
Workflow Runtime
     │
     ├── Session A → resultA
     ├── Session B → resultB
     ├── Session C → resultC
     │
     └── Session N → resultN
             │
             ▼
JS variables / runtime state
             │
             ▼
       Synthesis Agent
             │
             ▼
          Main
```

所以 100 个文件的 100 份分析**不需要全部进入 Main Agent context**。

这是它真正的价值。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)

* * *

# 二、OpenCode 能不能创建这些独立 Agent？

这是整个项目最关键的问题。

答案是：

# 可以。

而且是直接通过 OpenCode SDK。

目前 OpenCode 插件会拿到：

```TypeScript
{
  client,
  project,
  directory,
  worktree,
  $
}
```

其中：

```TypeScript
client
```

就是完整的 OpenCode SDK Client。 [OpenCode](https://opencode.ai/docs/plugins/)

当前 SDK 已经提供：

```TypeScript
client.session.create()
client.session.prompt()
client.session.messages()
client.session.abort()
client.session.delete()
client.session.children()
```

等接口。 [OpenCode+1](https://opencode.ai/docs/sdk/?utm_source=chatgpt.com)

也就是说你的：

```JavaScript
agent("分析 document-01.md")
```

完全可以翻译成：

```
agent()
 ↓
client.session.create()
 ↓
client.session.prompt()
 ↓
等待结果
 ↓
提取 assistant result
 ↓
return result
```

所以：

```JavaScript
await Promise.all([
   agent(task1),
   agent(task2),
   agent(task3),
])
```

本质就是：

```
OpenCode Session
 ├─ child session
 ├─ child session
 └─ child session
```

这部分不存在架构障碍。

* * *

# 三、甚至 Model Routing 也非常容易做

Pi 版本支持：

```JavaScript
agent(prompt, {
    tier: "small"
})

agent(prompt, {
    tier: "medium"
})

agent(prompt, {
    tier: "big"
})
```

Pi 自己维护：

```JSON
{
  "small": "...",
  "medium": "...",
  "big": "..."
}
```

然后转成具体模型。 [GitHub+1](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/src/agent.ts)

OpenCode 本身就支持给单次 Session Prompt 指定模型：

```TypeScript
await client.session.prompt({
    ...
    body: {
        model: {
            providerID: "...",
            modelID: "..."
        }
    }
})
```

[OpenCode](https://opencode.ai/docs/sdk/)

所以你完全可以设计：

```JSON
{
  "tiers": {
    "small": "openai/gpt-5.4-mini",
    "medium": "anthropic/claude-sonnet-4-6",
    "big": "openai/gpt-5.6"
  }
}
```

然后：

```JavaScript
agent(prompt, {
   tier: "small"
})
```

由你的 Runtime 自动转换。

这一层甚至比 Pi 更好实现。

* * *

# 四、Structured Output 在 OpenCode 上反而更简单

Pi Dynamic Workflow 自己实现了：

```
schema
 ↓
structured_output tool
 ↓
model 调用 tool
 ↓
JSON Schema validate
 ↓
失败
 ↓
repair
```

Pi 的代码里专门有 `structured-output.ts`，如果模型没有正确输出 schema，还会做 extraction / repair。 [GitHub+1](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/src/agent.ts)

但 OpenCode 当前 SDK 的：

```TypeScript
session.prompt()
```

已经支持：

```
body.outputFormat
```

来做 structured output。 [OpenCode](https://opencode.ai/docs/sdk/)

因此你的 DSL：

```JavaScript
const result = await agent(
   "分析这个文件",
   {
      schema: {
         type: "object",
         properties: {
             risks: {
                 type: "array"
             }
         }
      }
   }
)
```

底层可以直接映射成 OpenCode Structured Output。

这部分我反而建议**不要照抄 Pi 实现**。

直接利用 OpenCode Native Structured Output。

* * *

# 五、真正值得“移植”的，其实是 Workflow Runtime

这是我认为这个项目最漂亮的部分。

Pi Dynamic Workflow 不是让 LLM 自己反复：

```
调用 SubAgent
等待
读取
调用 SubAgent
等待
读取
...
```

而是：

```
LLM
 ↓
生成一次 JS
 ↓
Runtime 接管
```

例如：

```JavaScript
const docs = [
  "a.md",
  "b.md",
  "c.md"
]

const reports = await parallel(
  docs.map(doc => () =>
    agent(`分析 ${doc}`)
  )
)

const final = await agent(`
综合这些结果：

${reports.join("\n")}
`)

return final
```

这个 JS 是运行在 Node `vm` 中的。

Pi 项目甚至专门禁止了：

```
Date.now()
Math.random()
require()
import
filesystem
network
```

来提高 Workflow 的 deterministic replay 能力。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/src/workflow.ts)

这部分：

# 基本可以原样移植。

因为它跟 Pi Agent 本身关系不大。

* * *

# 六、哪些 Pi 代码可以复用

这是非常关键的一点。

这个项目是 **MIT License**。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/package.json)

所以你可以直接参考甚至 fork 一部分实现。

我会这样拆：

| pi-dynamic-workflows | OpenCode 版本 | 复用程度 |
| --- | --- | --- |
| workflow.ts | workflow-runtime.ts | ★★★★★ |
| workflow-manager.ts | workflow-manager.ts | ★★★★★ |
| run-persistence.ts | run-persistence.ts | ★★★★★ |
| fs-persistence.ts | fs-persistence.ts | ★★★★★ |
| structured-output.ts | OpenCode outputFormat | ★★ |
| model-routing.ts | model-routing.ts | ★★★★ |
| model-tier-config.ts | model-tier-config.ts | ★★★★★ |
| worktree.ts | worktree.ts | ★★★★ |
| agent.ts | opencode-agent.ts | ★★ |
| workflow-tool.ts | OpenCode Plugin Tool | ★★★ |
| task-panel.ts | OpenCode UI | ★ |
| workflow-ui.ts | OpenCode UI | ★ |

其中真正需要重写的是：

```
Pi Agent Runtime
        ↓
OpenCode Session API
```

也就是：

```
agent.ts
```

这一层。

* * *

# 七、我建议 OpenCode 版本做成这个架构

```
                  OpenCode
                     │
                     │
             dynamic-workflow plugin
                     │
        ┌────────────┴────────────┐
        │                         │
   workflow tool          workflow_control tool
        │
        ▼
 WorkflowManager
        │
        ▼
 Workflow Runtime
 Node VM + JS DSL
        │
        ├────────────┐
        │            │
      agent()     parallel()
        │            │
        ▼            ▼
 SessionRunner   ConcurrencyLimiter
        │
        ▼
 OpenCode SDK
        │
 ┌──────┼──────┬──────┐
 ▼      ▼      ▼      ▼
S1     S2     S3     S4
 │      │      │      │
LLM    LLM    LLM    LLM
 │      │      │      │
 └──────┴──┬───┴──────┘
           ▼
      JS variables
           │
           ▼
     Synthesizer
           │
           ▼
       Final Result
```

Main Agent 只会看到：

```
workflow(...)
```

以及：

```
最终结果
```

而不是：

```
agent1 20K tokens
agent2 15K tokens
agent3 18K tokens
...
agent100 12K tokens
```

这恰好就是你之前一直在关注的**主上下文污染问题**。

* * *

# 八、`agent()` 在 OpenCode 里大概会长这样

示意实现：

```TypeScript
async function runAgent(
  prompt: string,
  options: AgentOptions
) {

  const session = await client.session.create({
    body: {
      title: options.label
    }
  })

  const model =
    resolveModel(options.tier)

  const result =
    await client.session.prompt({
      path: {
        id: session.id
      },
      body: {
        model,
        parts: [
          {
            type: "text",
            text: prompt
          }
        ],
        outputFormat:
          options.schema
            ? {
                type: "json_schema",
                schema: options.schema
              }
            : undefined
      }
    })

  return extractResult(result)
}
```

于是：

```JavaScript
parallel([
   () => agent("分析A"),
   () => agent("分析B"),
   () => agent("分析C")
])
```

本质就是：

```TypeScript
await Promise.all(...)
```

再加一个：

```
Semaphore
```

控制并发。

* * *

# 九、Concurrency 基本没有难点

Pi 做的是：

```
maxAgents = 1000
concurrency <= 16
```

它内部会做 agent reservation、queue、abort、fan-out cancellation 等控制。 [GitHub+1](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/src/workflow.ts)

OpenCode 版本可以直接：

```
Workflow
   │
   ├── 100 tasks
   │
   ▼
Semaphore(8)
   │
   ├─ agent
   ├─ agent
   ├─ agent
   ├─ agent
   ├─ agent
   ├─ agent
   ├─ agent
   └─ agent

完成一个
 ↓
再启动一个
```

建议一开始：

```JSON
{
  "concurrency": 8,
  "maxAgents": 100
}
```

不要直接上 100 并发。

因为真正瓶颈往往不是 OpenCode，而是：

```
Provider rate limit
API concurrency limit
TPM
RPM
磁盘 IO
Git
```

* * *

# 十、Worktree Isolation：能做，但需要插件自己管理

Pi 支持：

```JavaScript
agent(prompt, {
   isolation: "worktree"
})
```

它会：

```
git worktree
      ↓
独立 branch
      ↓
Agent 编辑
```

这样两个 Agent 可以同时修改：

```
src/player.ts
```

而不会互相覆盖。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/main/src/worktree.ts)

OpenCode 目前自己其实已经有 Worktree 相关基础设施，但**原生 subagent 自动 worktree isolation 仍然有人在提议补齐**；当前 child session 默认仍可能继承父 session directory。 [GitHub](https://github.com/anomalyco/opencode/issues/34216?utm_source=chatgpt.com)

不过插件完全可以自己：

```
git worktree add
        ↓
client.session.create(
    directory = worktreePath
)
```

OpenCode SDK / 新 API 已经支持按 directory 创建 Session。 [GitHub+1](https://github.com/anomalyco/opencode/blob/dev/packages/app/src/utils/server-compat.ts?utm_source=chatgpt.com)

所以：

**功能能实现，只是不是一句 OpenCode 配置就完成。**

* * *

# 十一、Resume / Journal 也可以直接移植

Pi Dynamic Workflow 的一个非常强的能力是：

```
agent1 ✓
agent2 ✓
agent3 ✓
agent4 running
agent5 pending
```

程序中断以后：

```
resume
```

不会重新跑：

```
agent1
agent2
agent3
```

而是直接 replay 已完成结果。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)

它的本质非常简单：

```
callIndex
prompt
model
schema
 ↓
hash
 ↓
journal
```

例如：

```JSON
{
  "runId": "workflow-123",
  "calls": {
    "0": {
      "hash": "abc...",
      "result": "..."
    },
    "1": {
      "hash": "def...",
      "result": "..."
    }
  }
}
```

再次执行：

```JavaScript
agent(prompt)
```

计算：

```
hash
```

如果一样：

```
return cachedResult
```

不调用 LLM。

这部分几乎跟 OpenCode 无关。

所以可以高比例复用 Pi 的设计。

* * *

# 十二、最大的难点：UI

这一点需要特别说。

Pi 有自己的扩展 UI，所以能显示：

```
◆ Workflow: inspect_project 37/100

✓ Scan
✓ doc-01
✓ doc-02
● doc-03
● doc-04
○ doc-05
...
```

甚至有：

```
/workflows
/workflows pause
/workflows resume
/workflows stop
```

Pi README 展示了完整的 Workflow Navigator 和实时 panel。 [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)

OpenCode 当前插件可以监听大量：

```
session.*
message.*
tool.*
tui.*
```

事件。 [OpenCode](https://opencode.ai/docs/plugins/)

但是：

**稳定版插件 API 还没有提供 Pi 那么自由的“自定义完整 TUI Panel”。**

而且有一个当前已知问题：

插件直接通过 `session.create(parentID)` 创建的 child session，虽然后端存在，但 **OpenCode TUI 不一定会像原生 task subagent 那样显示这些 child sessions**。 [github.com](https://github.com/anomalyco/opencode/issues/29175?utm_source=chatgpt.com)

所以我会把：

```
运行能力
```

和：

```
展示能力
```

分开。

* * *

# 十三、功能可行性表

| 功能 | OpenCode | 难度 |
| --- | --- | --- |
| workflow tool | ✅ | 低 |
| JS workflow | ✅ | 低 |
| `agent()` | ✅ | 低 |
| `parallel()` | ✅ | 低 |
| `pipeline()` | ✅ | 低 |
| `phase()` | ✅ | 低 |
| 大量 child Session | ✅ | 低 |
| concurrency limit | ✅ | 低 |
| per-agent model | ✅ | 低 |
| model tier | ✅ | 低 |
| structured output | ✅ | **比 Pi 更简单** |
| verify | ✅ | 低 |
| judgePanel | ✅ | 低 |
| token accounting | ✅ | 中 |
| cost accounting | ✅ | 中 |
| retry | ✅ | 低 |
| timeout | ✅ | 低 |
| abort | ✅ | 低 |
| journal | ✅ | 中 |
| resume | ✅ | 中 |
| worktree isolation | ✅ | 中 |
| background workflow | ✅ | 中高 |
| workflow_control | ✅ | 中 |
| 自动回传 Main Session | ✅ | 中 |
| Pi 风格实时 Panel | ⚠️ | 高 |
| 完整 `/workflows` TUI | ⚠️ | 很高 |

因此：

```
Runtime：
███████████████████░ 95%

Workflow 功能：
██████████████████░░ 90%

UI：
██████████░░░░░░░░░░ 50~60%

整体：
████████████████░░░░ 80~90%
```

* * *

# 十四、反而有一点：OpenCode 可能比 Pi 更适合长期做

因为 OpenCode 当前插件体系已经把：

```
Plugin
SDK
Session
Model
Agent
Tools
Permissions
Events
```

都暴露出来了。当前 `@opencode-ai/plugin` 我查询到的稳定包已经是 **1.18.26**。 [NPM](https://www.npmjs.com/package/%40opencode-ai/plugin?activeTab=code&utm_source=chatgpt.com)

而且 OpenCode 新版插件 API 正在进一步把：

```
session.create
session.switchModel
session.switchAgent
session.prompt
session.generate
session.wait
tool.transform
storage
```

直接放进 Plugin Context。 [OpenCode](https://opencode.ai/v2/docs/build/plugins/)

尤其这个：

```TypeScript
ctx.storage
```

以后拿来做：

```
journal
workflow cache
resume
settings
```

会非常舒服。 [OpenCode](https://opencode.ai/v2/docs/build/plugins/)

* * *

# 十五、我建议不要一开始 Fork 整个项目硬改

最好的路线是先做一个 **最小闭环 Spike**：

1. 创建 `opencode-dynamic-workflows` 插件，只注册一个 `workflow` custom tool；让它接受 JS script，并在 Node VM 中暴露 `agent()` 和 `parallel()`。
2. `agent()` 内部调用 `client.session.create()` + `client.session.prompt()`，先实现 3 个 Agent 并行分析 3 个文件。
3. 验证最关键的一件事：Main Session context 里只出现 workflow 调用和最终汇总，而不是 3 个 child session 的完整上下文。
4. 然后把并发扩展到 10 → 50 → 100 个文件，并加入 Semaphore、timeout、abort、retry。
5. 再从 `pi-dynamic-workflows` 移植 `pipeline / phase / journal / resume / verify / judgePanel / model tier / worktree`。
6. 最后才做 `workflow_control`、background execution 和 UI。

我尤其建议：

> **第一版完全不要做 `/workflows` TUI。**

先证明：

```
Main Agent
   ↓
生成 JS
   ↓
workflow tool
   ↓
100 OpenCode Sessions
   ↓
workflow 内部结果
   ↓
1 Synthesizer Session
   ↓
Main Agent
```

这一整条链路成立。

一旦这个跑通，**这个项目最重要的 70% 已经完成了**。

* * *

# 十六、我给这个项目的定位建议

甚至名字都可以很直接：

```
opencode-dynamic-workflows
```

核心目录：

```
opencode-dynamic-workflows/

src/
├─ plugin.ts
│
├─ tools/
│  ├─ workflow.ts
│  └─ workflow-control.ts
│
├─ runtime/
│  ├─ workflow-runtime.ts
│  ├─ vm.ts
│  ├─ parallel.ts
│  ├─ pipeline.ts
│  └─ semaphore.ts
│
├─ agent/
│  ├─ session-runner.ts
│  ├─ model-routing.ts
│  ├─ structured-output.ts
│  └─ usage.ts
│
├─ persistence/
│  ├─ journal.ts
│  ├─ run-store.ts
│  └─ resume.ts
│
├─ isolation/
│  └─ worktree.ts
│
└─ config/
   ├─ settings.ts
   └─ model-tiers.ts
```

这里最核心的是：

```
session-runner.ts
```

它就是：

```
Pi createAgentSession()
        ↓
替换成
        ↓
OpenCode client.session.*
```

其他大量 Workflow 层代码可以继续沿用原项目思想。

* * *

# 最终判断

我认为这个项目**非常值得做**。

而且不是“OpenCode 勉强能模拟 Pi Dynamic Workflow”，而是：

> **OpenCode 已经有了实现 Dynamic Workflow 所需要的大部分底层 primitive。**

你真正需要开发的是：

```
OpenCode
已有：
Session
Model
Agent
Tools
Permissions
Events
Structured Output
        │
        ▼
你补：
Workflow Runtime
Scheduler
Journal
Resume
Model Routing
Worktree Manager
        │
        ▼
opencode-dynamic-workflows
```

所以我不会从“移植 Pi 插件”这个角度设计，而会从：

> **把 `pi-dynamic-workflows` 的 Workflow Runtime 抽出来，然后给它换一个 OpenCode Session Adapter。**

这个角度来做。

这样架构会干净很多，而且未来 OpenCode 1.x → 2.x，只需要换：

```
OpenCodeSessionAdapter
```

Workflow Runtime 基本不动。

**如果让我现在开始落地，我第一阶段只做 `agent() + parallel() + workflow tool + OpenCode child session` 这四件事。** 先拿“100 个文档并行分析、主上下文不爆炸”作为第一个验收用例。这个用例一旦跑通，就能证明这套方案真正成立。

* * *

**You:**

opencode plugins开发有git库参考吗，我需要提供一个模版给ai，不让他跑偏

* * *

**ChatGPT:**

有，而且你这个需求里，**最好不要让 AI“自由参考 OpenCode 文档”**，而是明确规定一套“参考优先级 + 固定版本 + 模板目录”。这样最不容易跑偏。

我建议你给 AI 固定这 4 个参考源：

1. **OpenCode 官方仓库**：最重要，作为 API 真值来源。重点看 `packages/plugin/`、`packages/opencode/src/plugin/`、`packages/sdk/` 和官方 plugin docs。当前稳定版 OpenCode / `@opencode-ai/plugin` 是 `1.18.26`，建议模板直接 pin 这个版本。 [NPM+1](https://www.npmjs.com/package/%40opencode-ai/plugin?activeTab=code&utm_source=chatgpt.com)  
    [OpenCode 官方仓库](https://github.com/anomalyco/opencode?utm_source=chatgpt.com)  
    官方 packages/plugin  
    [官方 Plugin 文档源码](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/plugins.mdx?utm_source=chatgpt.com)  
    官方文档明确给出了 `Plugin` 类型、本地插件目录、自定义 Tool、hook 和 `client` 上下文的标准写法。 [OpenCode+1](https://opencode.ai/docs/zh-cn/plugins/?utm_source=chatgpt.com)
2. **opencode-wakatime**：非常适合当“工程模板”。它不是复杂 Agent 框架，所以代码结构比较干净，包含 TypeScript、build、test、lint、npm package、插件入口等完整工程化内容，而且明确依赖 `@opencode-ai/plugin`。 [GitHub+1](https://github.com/angristan/opencode-wakatime/blob/master/README.md?utm_source=chatgpt.com)  
    [opencode-wakatime](https://github.com/angristan/opencode-wakatime?utm_source=chatgpt.com)  
    我会让 AI 学它的“项目怎么搭”，但**不要学它的业务逻辑**。
3. **magic-context**：适合参考“复杂插件怎么拆层”。它已经把 OpenCode-facing adapter、hooks、features、tools、持久化等拆开，而不是把所有东西塞进 `index.ts`。这非常适合你后面的 Dynamic Workflow。 [GitHub+1](https://github.com/cortexkit/magic-context/blob/master/packages/plugin/src/index.ts?utm_source=chatgpt.com)  
    [magic-context](https://github.com/cortexkit/magic-context?utm_source=chatgpt.com)
4. **oh-my-opencode / oh-my-openagent 系列**：只用来参考 **child session / subagent orchestration**，不要把它当基础模板，因为规模太大，AI 很容易照着抄出一堆你根本不需要的 Agent、MCP、兼容层。现有实现确实使用过 `ctx.client.session.create()` 创建子 Session，因此和你的 Dynamic Workflow 方向非常接近。 [GitHub+1](https://github.com/code-yeongyu/oh-my-openagent/issues/1516?utm_source=chatgpt.com)  
    [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode?utm_source=chatgpt.com)

* * *

## 我更建议你自己做一个 Golden Template

不要每次告诉 AI：

> “参考 OpenCode 官方开发一个插件。”

而是建立你自己的：

```
opencode-plugin-template/
```

以后所有插件：

```
dynamic-workflows
langfuse-monitor
skill-isolation
workflow-runtime
...
```

全部从这个模板复制。

我建议模板固定成：

```
opencode-plugin-template/
│
├─ src/
│  ├─ index.ts
│  │
│  ├─ plugin/
│  │  ├─ context.ts
│  │  └─ hooks.ts
│  │
│  ├─ tools/
│  │  └─ example-tool.ts
│  │
│  ├─ services/
│  │  └─ example-service.ts
│  │
│  └─ types/
│     └─ index.ts
│
├─ tests/
│  ├─ plugin.test.ts
│  └─ tools/
│     └─ example-tool.test.ts
│
├─ package.json
├─ tsconfig.json
├─ README.md
├─ AGENTS.md
└─ opencode-plugin-spec.md
```

其中最关键的是：

```
AGENTS.md
```

和：

```
opencode-plugin-spec.md
```

不是代码。

因为这两个文件专门负责**限制 AI 不要自己发明架构**。

* * *

# `package.json` 建议直接固定

以你现在开发时的稳定版本为基线：

```JSON
{
  "name": "opencode-plugin-template",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "1.18.26"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "1.18.26",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  }
}
```

这里我甚至建议：

```
1.18.26
```

而不是：

```
^1.18.26
```

因为你的目的不是做一个永远自动升级的模板。

你的目的是：

> **让 AI 在一个已知 API Surface 上开发。**

升级 OpenCode 时，你人工升级一次模板。

* * *

# `src/index.ts` 也固定成非常薄

例如：

```TypeScript
import type { Plugin } from "@opencode-ai/plugin"
import { createExampleTool } from "./tools/example-tool"

export const DynamicWorkflowPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      example: createExampleTool(ctx),
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // handle event
      }
    },
  }
}
```

不要允许 AI 把：

```
Session Manager
Scheduler
Runtime
Persistence
Worktree
Model Router
```

全部写进 `index.ts`。

* * *

# Tool 统一模板

```TypeScript
import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

export function createExampleTool(ctx: PluginInput) {
  return tool({
    description: "Example OpenCode plugin tool",

    args: {
      input: tool.schema
        .string()
        .describe("Input value"),
    },

    async execute(args, toolContext) {
      return {
        title: "Example",
        output: `Received: ${args.input}`,
        metadata: {},
      }
    },
  })
}
```

官方当前文档就是通过 `tool()` 注册插件自定义 Tool，并从插件 Context 获得 `client / directory / worktree` 等能力。 [OpenCode](https://opencode.ai/docs/zh-cn/plugins/?utm_source=chatgpt.com)

* * *

# 对你的 Dynamic Workflow，我会再加一层强制 Adapter

这是最重要的。

以后不要让：

```
workflow-runtime.ts
```

到处直接调用：

```TypeScript
ctx.client.session.create()
```

而是规定：

```
src/
├─ adapters/
│  └─ opencode-session-adapter.ts
│
├─ runtime/
│  ├─ workflow-runtime.ts
│  ├─ parallel.ts
│  └─ scheduler.ts
```

只有：

```
opencode-session-adapter.ts
```

允许知道 OpenCode SDK。

例如：

```TypeScript
export interface AgentSessionAdapter {

  create(options: {
    parentSessionId?: string
    title?: string
    directory?: string
  }): Promise<string>

  prompt(
    sessionId: string,
    prompt: string
  ): Promise<string>

  abort(
    sessionId: string
  ): Promise<void>

  delete(
    sessionId: string
  ): Promise<void>
}
```

然后：

```
Workflow Runtime
       │
       ▼
AgentSessionAdapter
       │
       ▼
OpenCodeSessionAdapter
       │
       ▼
ctx.client.session.*
```

这样 AI 就算以后理解错 OpenCode API，也只能改：

```
1 个 Adapter
```

而不是污染整个项目。

对于你这个项目，这个约束非常值。

* * *

# 再给 AI 一个 `AGENTS.md`

这个比 README 更重要。

我会写成这种：

```Markdown
# OpenCode Plugin Development Rules

## Source of truth

This project targets:

- OpenCode: 1.18.26
- @opencode-ai/plugin: 1.18.26
- TypeScript

Authoritative API references:

1. https://github.com/anomalyco/opencode/tree/dev/packages/plugin
2. https://github.com/anomalyco/opencode/tree/dev/packages/sdk
3. https://opencode.ai/docs/plugins/

Do NOT invent OpenCode APIs.

If an API cannot be found in the installed
@opencode-ai/plugin / @opencode-ai/sdk types,
do not use it.

## Architecture

OpenCode-specific APIs MUST only be used inside:

src/adapters/
src/plugin/
src/tools/

Business logic MUST NOT directly depend on OpenCode.

Correct:

runtime -> AgentSessionAdapter -> OpenCodeSessionAdapter

Incorrect:

runtime -> ctx.client.session.create()

## Plugin entrypoint

src/index.ts must remain thin.

It may only:

- initialize dependencies
- register hooks
- register tools
- register lifecycle handlers

Do not place business logic in src/index.ts.

## Session creation

Child sessions MUST be created through:

AgentSessionAdapter

Do not call client.session.create directly outside
OpenCodeSessionAdapter.

## Workflow runtime

Workflow Runtime must remain host-independent.

It must not import:

@opencode-ai/plugin
@opencode-ai/sdk

## API verification

Before using an OpenCode API:

1. Check local TypeScript types.
2. Check official OpenCode source.
3. Check official documentation.

Never infer an API from another agent framework.

Do NOT copy APIs from:

- Claude Code
- Pi
- Codex
- MCP

unless an explicit OpenCode equivalent exists.

## Version policy

Do not upgrade @opencode-ai/plugin automatically.

Do not use OpenCode v2 plugin APIs unless this repository
has explicitly migrated to v2.

Do not mix v1 and v2 plugin APIs.
```

这一段尤其重要：

```
Do not mix v1 and v2 plugin APIs.
```

因为 OpenCode 现在已经同时存在当前插件文档和新的 V2 Plugin 文档；V2 使用的是 `Plugin.define({ id, setup })` 这种入口，而当前 1.x 文档仍大量使用 `export const MyPlugin: Plugin = async (...) => ...`。如果不给 AI 限死，它非常容易混用两套 API。 [OpenCode+1](https://opencode.ai/v2/docs/build/plugins?utm_source=chatgpt.com)

* * *

# 所以我给你的参考策略是

```
                 OpenCode 官方仓库
                     │
                  API 真值
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
 opencode-wakatime        magic-context
   工程模板参考             架构参考
                                │
                                ▼
                         oh-my-opencode
                        SubAgent 局部参考
                                │
                                ▼
                    你自己的 Golden Template
                                │
             ┌──────────────────┼───────────────┐
             ▼                  ▼               ▼
        dynamic-workflow     langfuse       skill-runtime
```

**不要让 AI 每次直接从这些 GitHub 项目开始写。**

正确做法是：

> 你先建立自己的 `opencode-plugin-template`，以后告诉 AI：“只能基于这个模板开发；OpenCode 官方仓库仅用于验证 API。”

这会比单纯给它 `pi-dynamic-workflows + opencode GitHub` 稳定非常多。

对于你现在这个 **Dynamic Workflow** 项目，我甚至建议下一步直接先把这个 `opencode-plugin-template` 做出来，然后再 Fork 成 `opencode-dynamic-workflows`。这样第一阶段就把 **AI 编码边界、OpenCode Adapter、测试结构、版本锁定** 全部定死，后面开发 Workflow Runtime 基本不会跑偏。