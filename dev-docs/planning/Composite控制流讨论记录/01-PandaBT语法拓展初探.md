**You:**

https://www.pandabt.com/documentation 看一下这个里面的各种语法

* * *

**ChatGPT:**



* * *

**You:**

我想给mickorz/opencode-dynamicworkflows 这个dynamic workflow 添加类的语法，你觉得怎么样，有必要吗

* * *

**ChatGPT:**

如果你这里说的“类的语法”是指 **类似 PandaBT 那种树状 DSL 语法**，我觉得**值得加，而且和你的 Dynamic Workflow 非常契合**；但我不建议替换现在的 JavaScript，而是把它作为一层新的“声明式 Workflow DSL”。

你现在的 Dynamic Workflow 本质上已经有一个小型 DSL：`agent / parallel / pipeline / phase / log / args`，脚本外壳则还是普通 async JavaScript。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md) 当前 README 也明确把它定位成由 Main Agent 生成 JavaScript 编排脚本、VM 沙箱执行，并且已经支持质量节点、嵌套 workflow、journal/resume 和 TUI 树。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows)

所以我会这样判断：

**如果你说的是 OOP 的 `class Workflow {}`：没必要。**  
**如果你说的是 PandaBT 风格的树状语法：有价值，而且值得做。**

* * *

## 为什么你的 Dynamic Workflow 很适合这种语法

你现在一个工作流大概是：

```JavaScript
export const meta = {
  name: 'develop_feature'
}

phase('Analyze')

const requirement = await agent('分析需求')

phase('Develop')

const results = await parallel([
  () => agent('实现前端'),
  () => agent('实现后端'),
  () => agent('编写测试')
])

phase('Review')

const review = await agent(
  `检查结果：${JSON.stringify(results)}`
)

return {
  requirement,
  results,
  review
}
```

这个对程序员当然没问题。

但随着你的 Workflow 越来越复杂，你之前遇到的问题就会逐渐出现：

```
if
  if
    if

try
  catch

parallel(...)
pipeline(...)
retry(...)
checkpoint(...)
```

最后 Workflow 从“流程定义”变成了“程序”。

尤其你之前问过：

> phase1 失败以后，我想直接跳最后一个 phase，但我不喜欢嵌套 if。

这恰恰就是**树状 Workflow DSL 能解决的问题**。

* * *

# 我建议你最终做成两层

```
                 Workflow DSL
                     │
                     ▼
              Parser / Validator
                     │
                     ▼
                    AST
                     │
                     ▼
          Dynamic Workflow Runtime
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
    agent()       parallel()      retry()
       │
       ▼
   OpenCode Agent
```

也就是说：

```
DSL = 写法

Runtime = 执行引擎
```

**不要重新做执行引擎。**

你现在 Runtime 已经有：

```
agent
parallel
pipeline
retry
verify
judgePanel
checkpoint
phase
journal
resume
background
nested workflow
```

而且 resume 当前根据调用位置进行 journal 回放。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)

这些全部保留。

* * *

# 我会设计成这种语法

例如：

```
workflow develop_feature

phase Analyze
    agent requirement
        prompt "分析需求文档"

phase Develop
    parallel
        agent frontend
            prompt "实现前端"

        agent backend
            prompt "实现后端"

        agent tests
            prompt "编写测试"

phase Review
    agent review
        prompt "检查实现结果"

return
    requirement
    frontend
    backend
    tests
    review
```

这个比：

```JavaScript
const results = await parallel([
    () => agent(...),
    () => agent(...),
    () => agent(...)
])
```

更像真正的：

> Workflow Definition

而不是：

> JavaScript program

* * *

# 更重要的是，可以引入 `sequence`

PandaBT 这种思想里，我觉得最值得你借鉴的其实就是：

```
sequence
parallel
fallback
race
repeat
```

例如：

```
workflow feature_dev

sequence

    agent analyze
        prompt "分析需求"

    parallel

        agent frontend
            prompt "开发前端"

        agent backend
            prompt "开发后端"

        agent test
            prompt "编写测试"

    agent review
        prompt "Code Review"

    agent summary
        prompt "生成最终报告"
```

语义非常明显：

```
Analyze
   ↓
┌ Frontend
├ Backend
└ Test
   ↓
Review
   ↓
Summary
```

你的 TUI 本来就在显示 Workflow 层级树，所以 DSL AST 和 TUI Tree 可以天然统一。你的仓库现在已经把嵌套 workflow 表示成层级树，这让这种方向尤其顺。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows)

* * *

# `fallback` 我尤其建议加

这个非常适合 Agent Workflow。

例如：

```
fallback

    agent fast_model
        model "gpt-5-mini"
        prompt "完成任务"

    agent strong_model
        model "gpt-5.6"
        prompt "完成任务"
```

语义：

```
fast_model 成功
      ↓
     结束

fast_model 失败
      ↓
strong_model
```

现在用 JS 写往往会变成：

```JavaScript
let result = await agent(...)

if (result == null) {
    result = await agent(...)
}
```

Workflow DSL：

```
fallback
    agent A
    agent B
```

明显更漂亮。

* * *

# 你之前不喜欢的 if 嵌套也能解决

比如你之前这个问题：

```
phase1
 ↓
失败
 ↓
直接 Final
```

可以设计成：

```
sequence

    agent analyze
        prompt "分析项目"
        onFail Final

    agent implement
        prompt "实现功能"

    agent test
        prompt "测试"

phase Final

    agent summary
        prompt "总结执行结果"
```

甚至：

```
agent analyze
    onSuccess Develop
    onFail Final
```

于是 Workflow 真正变成：

```
Analyze
  ├── success → Develop
  └── failed  → Final
```

而不是拿 JavaScript `if` 去模拟状态机。

* * *

# 但是有一个东西，我反而建议你不要照搬 PandaBT

### `random`

你的 Runtime 有一个很明确的设计：

```
禁 Date.now()
禁 Math.random()
禁 import
禁 require
```

目的就是：

> deterministic replay

README 现在明确把“VM 沙箱确定性护栏”作为能力之一。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows)

所以这种：

```
random
    agent A
    agent B
```

我不会加。

否则会直接破坏：

```
journal
resume
deterministic replay
A/B Test
```

* * *

# `while` 也要非常谨慎

不要允许：

```
while result.failed
    agent fix
```

因为 Agent 很可能：

```
fix
↓
failed
↓
fix
↓
failed
↓
……
```

无限烧 token。

如果做，只允许：

```
repeat max=3
    agent fix
```

或者：

```
retry max=3
    agent fix
```

你现在 Runtime 已经有 bounded `retry()`，默认 3 次并且有确定的耗尽行为，所以继续沿用这个设计更安全。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)

* * *

# 我建议第一版只加入 8 个节点

不要一下做 20 多种语法。

第一版：

```
workflow

phase

sequence

parallel

fallback

agent

retry

checkpoint
```

外加：

```
return
```

就够用了。

对应你现有能力：

```
DSL                Runtime

agent        →     agent()

parallel     →     parallel()

retry        →     retry()

checkpoint   →     checkpoint()

phase        →     phase()

sequence     →     顺序 await

fallback     →     result == null 后执行下一个

return       →     workflow return
```

这样实现成本其实并不高。

* * *

# 第二版再考虑

```
pipeline
race
foreach
workflow/subworkflow
verify
judge
condition
goto
```

例如：

```
foreach file in args.files
    parallel

        agent analyze
            prompt "分析 ${file}"
```

这会比目前：

```JavaScript
await parallel(
  files.map(file =>
    () => agent(`分析 ${file}`)
  )
)
```

对 LLM 来说更容易生成正确。

* * *

# 这里还有一个比“语法漂亮”更重要的收益

我认为这是你做 DSL **真正值得的理由**。

你当前 resume 机制按调用位置匹配：

> 首个变化调用及之后重跑，调用按位置匹配。

这是当前 Runtime 文档明确描述的行为。 [GitHub](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)

现在：

```JavaScript
await agent("A")
await agent("B")
await agent("C")
```

journal 类似：

```
call 0
call 1
call 2
```

假设以后 Workflow 改成：

```JavaScript
await agent("X")
await agent("A")
await agent("B")
await agent("C")
```

位置全变了。

但 DSL 可以天然给每个节点稳定 ID：

```
agent analyze.requirement
agent develop.frontend
agent develop.backend
agent review.code
```

AST：

```JSON
{
  "id": "develop.frontend",
  "type": "agent"
}
```

journal：

```
develop.frontend
     ↓
result
```

这样 Resume 可以从：

```
position-based
```

逐渐升级成：

```
node-id-based
```

这对你的 Dynamic Workflow 是一个**架构层面的升级**，不只是语法糖。

* * *

# 最终我推荐形成三个层级

用户甚至可以完全不碰 DSL：

```
自然语言

"分析需求，然后前后端并行开发，
完成以后 code review"
```

Main Agent 转换成：

```
Workflow DSL
```

例如：

```
workflow feature

sequence

    agent analyze
        prompt "分析需求"

    parallel
        agent frontend
            prompt "开发前端"

        agent backend
            prompt "开发后端"

    agent review
        prompt "Code Review"
```

再转成：

```
AST
```

最后交给：

```
Dynamic Workflow Runtime
```

这样就是：

```
                 Human
                   │
             Natural Language
                   │
                   ▼
                  LLM
                   │
                   ▼
              Workflow DSL
                   │
                Parser
                   │
                   ▼
                  AST
                   │
                   ▼
          ┌ Dynamic Runtime ┐
          │ agent           │
          │ parallel        │
          │ retry           │
          │ checkpoint      │
          │ journal         │
          │ resume          │
          └─────────────────┘
```

这其实已经开始从一个：

> OpenCode Workflow Plugin

变成：

> **Agent Workflow Engine**

* * *

## 所以我的建议

**值得做，但不要做 `class Workflow {}` 这种类语法。**

你现在已经是 JavaScript Runtime，再套一个 class：

```JavaScript
class MyWorkflow extends Workflow {
    async execute() {}
}
```

基本只是增加模板代码，没有解决真正的问题。

真正值得做的是：

**PandaBT 风格的声明式 Tree DSL + AST。**

而且我建议保持：

```
.js Workflow        ← 高级用户，永远支持

.flow Workflow      ← 新增，推荐使用
        ↓ compile
AST / Execution Plan
        ↓
现有 Runtime
```

这样不会破坏你现在 76 个 commit 已经积累起来的 `agent/parallel/pipeline/retry/checkpoint/journal/resume/TUI` 能力，反而是在上面加一层非常干净的 authoring language。 [GitHub+1](https://github.com/mickorz/opencode-dynamicworkflows)

如果按你这个项目现在的发展方向，我会把 **`.flow DSL + AST + stable node id`** 作为下一阶段比较值得做的一项，其中 **stable node id + journal/resume** 的价值甚至高于“语法更好看”。

* * *

**You:**

当前阶段对标他的节点，是先实现 类似逻辑，.flow dsl暂时不用

* * *

**ChatGPT:**

对，这样更合适。**当前阶段不要碰 `.flow DSL`，先把 PandaBT 的“节点执行模型”移植到你现有 JavaScript Runtime。**

PandaBT 真正值得对标的是它的节点组合语义：`sequence / fallback / parallel / race / repeat / while / not / mute` 等，节点通过 `Succeeded / Failed / Running` 传播状态。 [Manualzz+1](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com) 而你现在已经有 `agent / parallel / pipeline / retry / checkpoint / verify / judgePanel` 等执行能力，所以可以直接在 Runtime 上增加一层组合节点。 [NPM](https://www.npmjs.com/package/%40mickorz/opencode-dynamic-workflows?utm_source=chatgpt.com)

我建议这一阶段的目标定成：

> **Behavior-Tree-inspired Workflow Nodes**
> 
> 保持 JavaScript Workflow 不变，只增加可组合的 Runtime primitives。

### 第一版节点建议

| PandaBT | Dynamic Workflow | 建议 | 语义 |
| --- | --- | --- | --- |
| `tree` | `workflow()` / nested workflow | 暂不新增 | 已经有 workflow 本身 |
| `sequence` | `sequence()` | ✅ P0 | 顺序执行，遇失败立即结束 |
| `fallback` | `fallback()` | ✅ P0 | 顺序尝试，遇成功立即结束 |
| `parallel` | `parallel()` | ✅ 已有，增强 | 全部成功才成功，一个失败整体失败 |
| `race` | `race()` | ✅ P0 | 谁先成功就结束，其余取消 |
| `repeat` | `repeat()` | ✅ P0 | 有界重复 |
| `while` | `guard()` / `whileNode()` | P1 | 条件成立才继续执行子节点 |
| `if` | `condition()` | P1 | 条件分支 |
| `not` | `invert()` | ✅ P0 | success ↔ failure |
| `mute` | `alwaysSuccess()` | ✅ P0 | 忽略失败 |
| `random` | 不实现 | ❌ | 破坏 deterministic replay |

其中 `random` 我明确建议不要对标。你现在 Runtime 禁止 `Math.random()` 本来就是为了 deterministic replay / journal resume，加入随机节点反而破坏现有设计。 [NPM](https://www.npmjs.com/package/%40mickorz/opencode-dynamic-workflows?utm_source=chatgpt.com)

* * *

## 最关键的一步：先统一 NodeResult

不要直接开始写 `sequence()`。

PandaBT 节点之所以可以任意组合，核心不是语法，而是：

```
所有节点都有统一状态
```

PandaBT 使用：

```
Running
Succeeded
Failed
```

例如 `sequence` 遇到一个 Failed 就 Failed；`fallback` 遇到一个 Succeeded 就 Succeeded。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

但你的 Workflow 是 `async/await`，所以我建议**不要真的实现 BT Tick + Running 状态机**。

你的模型可以简化成：

```TypeScript
type NodeStatus =
  | "success"
  | "failure"
  | "cancelled"

interface NodeResult<T = unknown> {
  status: NodeStatus
  value?: T
  error?: Error
  metadata?: NodeMetadata
}
```

因为：

```
PandaBT                   Dynamic Workflow

Running                   Promise pending
Succeeded                 Promise → success
Failed                    Promise → failure
```

也就是说：

> **Promise 本身就是你的 Running。**

这个设计会简单非常多。

* * *

# 1. sequence()

当前可能写：

```JavaScript
const analyze = await agent('分析需求')

if (analyze) {
    const develop = await agent('开发')
    
    if (develop) {
        await agent('测试')
    }
}
```

以后：

```JavaScript
const result = await sequence([
    () => agent('分析需求'),
    () => agent('开发'),
    () => agent('测试'),
])
```

语义：

```
Analyze SUCCESS
      ↓
Develop SUCCESS
      ↓
Test SUCCESS
      ↓
sequence SUCCESS
```

如果：

```
Analyze SUCCESS
      ↓
Develop FAILURE
      ↓
STOP
```

直接：

```
sequence FAILURE
```

这就是 PandaBT 的 sequence 语义。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

这个我认为是**最高优先级**。

* * *

# 2. fallback()

这是我觉得第二有价值的节点。

```JavaScript
const result = await fallback([
    () => agent('用便宜模型解决'),
    () => agent('用强模型解决'),
    () => agent('人工处理方案'),
])
```

执行：

```
Agent A
   │
 failure
   ↓
Agent B
   │
 success
   ↓
 STOP
```

返回 B。

PandaBT 的 fallback 正是“从上到下执行，直到某个 child 成功”。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

这对 Agent Workflow 特别有意义：

```JavaScript
await fallback([
    () => fastAgent(...),
    () => strongAgent(...),
    () => fallbackAgent(...),
])
```

甚至未来可以组合：

```JavaScript
await fallback([
    () => verify(primaryResult),

    () => sequence([
        () => agent('修复问题'),
        () => verify(...)
    ])
])
```

* * *

# 3. parallel() 要改变一点语义

你已经有：

```JavaScript
await parallel([
    () => agent(...),
    () => agent(...),
])
```

所以不用重新做。

但建议把它纳入 NodeResult 系统。

PandaBT 的 parallel：

```
A success
B success
C success
─────────
SUCCESS
```

如果：

```
A success
B failure
C running
─────────
FAILURE
```

也就是说一个 child 失败，整个 parallel 失败。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

你可以支持：

```JavaScript
await parallel([
    nodeA,
    nodeB,
    nodeC
], {
    failurePolicy: 'fail-fast'
})
```

以后还可以：

```
fail-fast
wait-all
best-effort
```

不过第一版先：

```
fail-fast
```

足够。

* * *

# 4. race()

这个非常适合 Agent。

```JavaScript
const result = await race([
    () => agent('模型A解决问题'),
    () => agent('模型B解决问题'),
    () => agent('模型C解决问题'),
])
```

注意不是：

```
Promise.race
```

而应该是：

> **first successful result wins**

因为 PandaBT `race` 是有一个 child 成功就成功；只有全部失败才失败。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

例如：

```
Agent A ───── FAILURE
Agent B ───────────── SUCCESS ← winner
Agent C ─────────────────────────
                         ↑
                       cancel
```

这个和你 OpenCode child session + abort 机制非常搭。

* * *

# 5. repeat()

这个也应该做，但是**必须有上限**。

PandaBT 原始 `repeat` 支持无限重复。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

你不要支持：

```JavaScript
repeat(() => agent(...))
```

无限执行。

而应该强制：

```JavaScript
await repeat(
    () => agent('修复问题'),
    {
        max: 3
    }
)
```

甚至：

```JavaScript
await repeat(
    () => agent('修复问题'),
    {
        max: 3,
        until: result => result.success
    }
)
```

其实你当前的：

```JavaScript
retry(...)
```

和它非常接近。

所以可以考虑：

```
repeat = 通用节点
retry  = repeat 的 Agent-friendly specialization
```

而不是维护两套完全不同的底层逻辑。

* * *

# 6. invert() / not

Panda：

```
not child
```

语义特别简单：

```
SUCCESS → FAILURE
FAILURE → SUCCESS
RUNNING → RUNNING
```

[Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

你的版本：

```JavaScript
await invert(
    () => checkSomething()
)
```

例如：

```JavaScript
await sequence([
    () => invert(() => fileExists('error.txt')),
    () => agent('继续发布')
])
```

对于条件节点以后很有用。

* * *

# 7. mute → alwaysSuccess()

我不建议直接叫 `mute()`。

Agent Workflow 用户看到：

```JavaScript
mute(() => agent(...))
```

不太容易理解。

可以叫：

```JavaScript
alwaysSuccess(...)
```

例如：

```JavaScript
await sequence([
    () => alwaysSuccess(
        () => agent('尝试生成可选报告')
    ),

    () => agent('正式发布')
])
```

即：

```
child SUCCESS  → SUCCESS
child FAILURE  → SUCCESS
```

与 Panda `mute` 的行为一致。 [Manualzz](https://manualzz.com/doc/7256571/panda-behaviour-user-manual?utm_source=chatgpt.com)

* * *

# 8. Panda 的 while 不要直接照抄

这里有一个容易踩坑的地方。

Panda 的 `while` **实际上并不是普通编程语言里的 while loop**。Panda 作者自己专门解释过，它主要是一个“在某个 assumption 成立期间执行 child”的条件节点；真正的重复主要通过 `repeat` 完成。 [Unity Discussions](https://discussions.unity.com/t/ai-scripting-panda-bt-behaviour-tree-scripting-618270/618270?utm_source=chatgpt.com)

所以 Dynamic Workflow 里我甚至建议改名：

```JavaScript
guard(
    () => condition(),
    () => agent(...)
)
```

例如：

```JavaScript
await guard(
    () => hasRequirements(),
    () => agent('开始实现需求')
)
```

而不是：

```JavaScript
while(...)
```

因为 JS 里本身还有 `while` 关键字，很容易产生认知冲突。

* * *

# 最终第一版 API 我建议非常小

先只实现：

```JavaScript
sequence([
    nodeA,
    nodeB
])

fallback([
    nodeA,
    nodeB
])

parallel([
    nodeA,
    nodeB
])

race([
    nodeA,
    nodeB
])

repeat(node, {
    max: 3
})

invert(node)

alwaysSuccess(node)
```

所有节点统一：

```
                   Node
                    │
             ┌──────┴──────┐
             │             │
          success       failure
             │             │
             ▼             ▼
         NodeResult     NodeResult
```

于是它们就可以随意嵌套：

```JavaScript
await sequence([
    () => agent('分析需求'),

    () => parallel([
        () => agent('开发前端'),
        () => agent('开发后端'),
    ]),

    () => fallback([
        () => verify('验证实现'),

        () => sequence([
            () => agent('修复实现'),
            () => verify('重新验证'),
        ]),
    ]),

    () => agent('生成报告'),
])
```

这时候你实际上已经拥有：

```
              sequence
                  │
        ┌─────────┼───────────┐
      agent     parallel     fallback
                  │             │
               ┌──┴──┐      ┌──┴──────┐
             agent  agent  verify   sequence
                                      │
                                   ┌──┴──┐
                                 agent verify
```

**已经是 Behavior Tree 了，只是仍然用 JavaScript 表达。**

* * *

## 我认为最合理的开发顺序

```
Phase 1
统一 NodeResult / NodeStatus
        ↓
Phase 2
sequence + fallback
        ↓
Phase 3
增强 parallel + 新增 race
        ↓
Phase 4
repeat + invert + alwaysSuccess
        ↓
Phase 5
guard / condition
        ↓
Phase 6
组合节点测试 + resume/journal 测试
        ↓
Phase 7
再决定要不要做 .flow DSL
```

尤其 **Phase 1 必须先做**。否则你很容易变成每个函数自己判断：

```JavaScript
null
undefined
throw
false
{ success: false }
AgentResult
```

最后 `sequence/fallback/race` 全部各写一套判断逻辑。

所以我们现在真正应该先设计的不是 `.flow`，而是：

> **Dynamic Workflow Node Protocol**

这个 Protocol 定下来以后，PandaBT 的这些节点基本都是很薄的一层组合逻辑。

我建议下一步就直接把 **`NodeResult + sequence + fallback + race + repeat` 的 TypeScript API 和具体执行语义**定义出来，作为你这次新增功能的 V0.1 设计文档。

* * *

**You:**

sequence  能不能支持子workflow类似  ()=>workflow("xxx.js")这种

* * *

**ChatGPT:**

可以，而且我认为 **`sequence()` 应该从一开始就支持子 Workflow**。否则它会被限制成“Agent 顺序执行器”，而不是通用的 Workflow 组合节点。

你现有这套 Runtime 设计里，`workflow(nameOrScript, args?, opts?)` 本身就是一个可 `await` 的 child workflow：成功返回结果，child 执行失败通常返回 `null`；未知 workflow、循环引用、嵌套过深等结构性错误则可能直接抛错。 [GitHub](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/workflow.txt?utm_source=chatgpt.com)

所以这种写法完全合理：

```JavaScript
await sequence([
    () => agent("分析需求"),
    () => workflow("develop.js"),
    () => workflow("test.js"),
    () => agent("生成最终报告"),
])
```

执行结构就是：

```
sequence
│
├── agent: 分析需求
│
├── workflow: develop.js
│      ├── agent
│      ├── parallel
│      └── agent
│
├── workflow: test.js
│      ├── agent
│      └── verify
│
└── agent: 最终报告
```

### 关键不是专门支持 `workflow()`，而是定义统一 Node

我不建议写成：

```TypeScript
sequence(
    agents: AgentFunction[]
)
```

而应该定义成：

```TypeScript
type WorkflowNode<T = unknown> =
    () => T | Promise<T>
```

然后：

```TypeScript
async function sequence(
    nodes: WorkflowNode[]
): Promise<NodeResult>
```

这样 `sequence()` 根本不关心 child 是什么。

下面这些全部天然支持：

```JavaScript
await sequence([
    () => agent("分析需求"),

    () => workflow("design.js"),

    () => parallel([
        () => agent("前端"),
        () => agent("后端"),
    ]),

    () => fallback([
        () => workflow("test-a.js"),
        () => workflow("test-b.js"),
    ]),

    () => retry(
        () => workflow("fix.js"),
        { max: 3 }
    ),
])
```

这才是我建议你做 PandaBT 类节点时最重要的设计原则：

> **组合节点只认 Node，不认 Agent / Workflow / Parallel 的具体类型。**

* * *

## 那么你的节点系统就会非常漂亮

统一：

```TypeScript
type Node = () => Promise<any>
```

组合节点：

```
sequence(Node[])
fallback(Node[])
parallel(Node[])
race(Node[])
repeat(Node)
invert(Node)
alwaysSuccess(Node)
```

基础节点：

```
agent()       → Node execution
workflow()    → Node execution
verify()      → Node execution
checkpoint()  → Node execution
```

然后可以无限组合：

```JavaScript
await sequence([
    () => workflow("01-analyze.js"),

    () => parallel([
        () => workflow("02-client.js"),
        () => workflow("03-server.js"),
        () => workflow("04-ui.js"),
    ]),

    () => fallback([
        () => workflow("05-auto-test.js"),

        () => sequence([
            () => workflow("06-fix.js"),
            () => workflow("05-auto-test.js"),
        ]),
    ]),

    () => workflow("07-summary.js"),
])
```

这时候 Dynamic Workflow 就已经非常接近真正的 **Composite Workflow Engine** 了。

* * *

### `sequence()` 的停止规则要明确

比如：

```JavaScript
await sequence([
    () => workflow("analyze.js"),
    () => workflow("develop.js"),
    () => workflow("test.js"),
])
```

应该遵循：

```
analyze
   │
 success
   ↓
develop
   │
 failure
   ↓
sequence FAILURE

test 不执行
```

也就是说，如果你的 `workflow()` 目前 child 失败返回：

```JavaScript
null
```

那么 sequence 第一版甚至可以兼容现有 Runtime：

```TypeScript
async function sequence(nodes) {
    const results = []

    for (const node of nodes) {
        const result = await node()

        if (result == null) {
            return null
        }

        results.push(result)
    }

    return results
}
```

不需要先大改现有 `workflow()`。

以后再把内部统一升级成：

```TypeScript
NodeResult {
    status: "success" | "failure" | "cancelled"
    value?: unknown
}
```

* * *

## 甚至子 Workflow 传参也天然成立

比如：

```JavaScript
await sequence([
    () => workflow("analyze.js", {
        requirement: args.requirement
    }),

    () => workflow("implement.js", {
        project: args.project
    }),

    () => workflow("test.js", {
        mode: "full"
    }),
])
```

以及 workspace / concurrency：

```JavaScript
() => workflow(
    "develop.js",
    { feature: args.feature },
    {
        workspace: "./game",
        maxConcurrentAgents: 3
    }
)
```

这也符合现有 child workflow API 的设计。 [GitHub](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/workflow.txt?utm_source=chatgpt.com)

* * *

我甚至会把你的 V0.1 目标从：

```
sequence 支持 agent
```

改成：

```
sequence 支持任意 async Node
```

这样你以后根本不用再分别实现：

```
sequenceAgent()
sequenceWorkflow()
sequenceParallel()
```

而是统一：

```
                       Node
                        │
          ┌─────────────┼─────────────┐
          ↓             ↓             ↓
        agent        workflow      composite
                                    │
                         ┌──────────┼──────────┐
                         ↓          ↓          ↓
                     sequence   parallel   fallback
```

**`() => workflow("xxx.js")` 不只是应该支持，我认为它应该成为第一版测试用例之一。**

比如第一个集成测试直接做：

```JavaScript
await sequence([
    () => workflow("child-a.js"),
    () => workflow("child-b.js"),
    () => workflow("child-c.js"),
])
```

然后重点验证 **child failure、journal/resume、嵌套深度、cycle detection、取消传播和 concurrency ceiling**，因为这些才是 `sequence + child workflow` 真正容易出现问题的地方。