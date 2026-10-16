可以考虑取消，但我建议**不要因为 `sequence` 能传递数据就直接删掉 `pipeline`**。关键要先看清楚：你现在的 `pipeline(items, ...stages)` 实际是“多个 item 各自依次经过所有 stage，而且不同 item 之间没有 stage barrier”，它本质上是一个 **批处理/流式管线**，而不是单纯的顺序控制。([GitHub][1])

所以我建议把两个概念彻底拆开。

### 1. `sequence` 的数据怎么往下传

最简单、也最适合你当前 JS Runtime 的设计是：

```js
const result = await sequence([
    () =>
        workflow("01-analyze.js"),

    (prev) =>
        workflow("02-design.js", {
            analysis: prev
        }),

    (prev) =>
        workflow("03-develop.js", {
            design: prev
        }),

    (prev) =>
        workflow("04-test.js", {
            build: prev
        })
])
```

也就是：

```text
Node1 return
     ↓ prev
Node2 return
     ↓ prev
Node3 return
     ↓ prev
Node4 return
```

这和普通 JS：

```js
const analysis = await workflow("01-analyze.js")

const design = await workflow(
    "02-design.js",
    { analysis }
)

const develop = await workflow(
    "03-develop.js",
    { design }
)
```

完全一致，只是把控制流抽象成了一个节点。

我建议 `sequence` 的 callback 统一定义为：

```ts
type SequenceNode<TPrev = unknown, TResult = unknown> =
    (
        prev: TPrev,
        ctx: SequenceContext
    ) => TResult | Promise<TResult>
```

其中：

```ts
interface SequenceContext {
    index: number

    // sequence 初始传入的数据
    input: unknown

    // 前面所有节点结果
    results: unknown[]

    // root workflow args
    args: unknown
}
```

这样既能拿上一步：

```js
(prev) => ...
```

也能拿第一步结果：

```js
(prev, ctx) => workflow("summary.js", {
    analysis: ctx.results[0],
    design: ctx.results[1],
    develop: ctx.results[2]
})
```

例如：

```js
await sequence([
    () =>
        workflow("analyze.js"),

    (analysis) =>
        workflow("design.js", {
            analysis
        }),

    (design) =>
        workflow("develop.js", {
            design
        }),

    (develop, ctx) =>
        workflow("summary.js", {
            analysis: ctx.results[0],
            design: ctx.results[1],
            develop
        })
])
```

这样就解决了：

> 数据不一定只需要上一步的问题。

---

### 2. 不建议搞一个全局共享 `state`

比如：

```js
await sequence([
    async ctx => {
        ctx.analysis = await workflow(...)
    },

    async ctx => {
        ctx.design = await workflow(...)
    }
])
```

我不太建议。

因为慢慢就会变成：

```js
ctx.xxx
ctx.yyy
ctx.temp
ctx.result
ctx.output
```

最后形成隐式共享状态。

对：

```text
resume
journal
debug
A/B Test
LLM 自动生成
```

都不好。

还是：

```text
return value
     ↓
prev
```

最清晰。

---

# 3. 那它和 Pipeline 冲突吗？

**表面很像，但实际上应该是两个维度。**

`sequence`：

```text
一个任务
    │
    ▼
Analyze
    │
    ▼
Design
    │
    ▼
Develop
    │
    ▼
Test
```

核心是：

> **节点之间的控制流。**

而你现在 `pipeline(items, ...stages)` 的定义是：

> 每个 item 都经过所有 stages，并且不同 item 不需要等待整个 stage 完成。([GitHub][1])

例如：

```js
await pipeline(
    ["a.ts", "b.ts", "c.ts"],

    file =>
        workflow("analyze.js", { file }),

    analysis =>
        workflow("fix.js", { analysis }),

    result =>
        workflow("verify.js", { result })
)
```

结构其实是：

```text
a.ts → Analyze → Fix → Verify
          │
b.ts ─────┼→ Analyze → Fix → Verify
          │
c.ts ─────┴────→ Analyze → Fix → Verify
```

而不是：

```text
Analyze all
     ↓
Fix all
     ↓
Verify all
```

所以它其实是：

> **Concurrent Item Pipeline**

这跟：

```js
sequence([...])
```

不是一回事。

---

# 4. 但是你感觉它们冲突，是有原因的

因为名字：

```text
pipeline
```

太宽泛了。

很多人看到：

```js
pipeline([
    stageA,
    stageB,
    stageC
])
```

第一反应就是：

```text
A → B → C
```

也就是 `sequence`。

而你现在真正的 Pipeline 是：

```text
Items × Stages
```

所以我认为这里真正的问题不是：

> pipeline 应不应该存在？

而是：

> **pipeline 这个名字是不是不够准确？**

答案是：是的。

---

# 5. 我反而建议改名字

如果你准备做一次 Runtime 整理，我会考虑把：

```js
pipeline(items, ...stages)
```

改成：

```js
flowEach(items, ...stages)
```

或者我更喜欢：

```js
processEach(items, ...stages)
```

例如：

```js
await processEach(
    files,

    file => workflow("analyze.js", { file }),

    analysis => workflow("fix.js", { analysis }),

    fixed => workflow("verify.js", { fixed })
)
```

名字一下就清晰了：

> 对每个 item 执行这一条处理链。

或者：

```js
stream(
    files,
    analyze,
    fix,
    verify
)
```

不过 `stream` 又容易让人想到 Node Stream。

所以我个人更喜欢：

```text
processEach
```

---

# 6. 甚至 Pipeline 可以由 `parallel + sequence` 实现

这个特别重要。

假设现在：

```js
pipeline(
    files,
    analyze,
    fix,
    verify
)
```

实际上完全可以表达成：

```js
parallel(
    files.map(file => () =>
        sequence([
            () =>
                analyze(file),

            analysis =>
                fix(analysis),

            fixed =>
                verify(fixed)
        ])
    )
)
```

也就是：

```text
pipeline(files, A, B, C)

实际上等价于：

parallel([
    sequence(A1, B1, C1),
    sequence(A2, B2, C2),
    sequence(A3, B3, C3)
])
```

结构上：

```text
                    parallel
                       │
          ┌────────────┼────────────┐
          │            │            │
      sequence      sequence      sequence
          │            │            │
          A            A            A
          ↓            ↓            ↓
          B            B            B
          ↓            ↓            ↓
          C            C            C
```

这时候问题就来了：

> **既然 Composite Node 已经可以表达 Pipeline，还有没有必要保留一个专门的 Pipeline primitive？**

现在这个问题就值得认真考虑了。

---

# 7. 我倾向于：从核心模型里取消 Pipeline

这里我的建议和刚开始有所变化。

如果你真的准备往：

```text
sequence
parallel
fallback
race
```

这套 Composite Model 走，

那么我会倾向于把：

```text
pipeline
```

从：

> **Core Primitive**

降级成：

> **Convenience Helper**

甚至最终 deprecated。

因为：

```text
sequence + parallel
```

实际上已经覆盖了 pipeline 的表达能力。

---

# 8. 这样你的核心模型会非常干净

现在：

```text
agent
workflow

parallel
pipeline
retry
verify
judgePanel
checkpoint
...
```

有点像：

> 一个需求来了，就增加一个 helper。

长期容易膨胀。

改成 Composite Model 后：

```text
                     Node
                      │
          ┌───────────┴───────────┐
          │                       │
         Leaf                  Composite
          │                       │
    ┌─────┼─────┐        ┌────────┼────────┐
   agent workflow       sequence parallel
   verify                  │       │
                       fallback   race
```

然后：

```text
retry
processEach
judgePanel
...
```

可以是：

> Higher-level helper

而不是 Runtime 最基础的控制结构。

---

# 9. 我会把层级明确分成两层

### Core

只有：

```js
agent()
workflow()

sequence()
parallel()
fallback()
race()
```

这些是：

> **Workflow Control Primitives**

### Helpers

建立在 Core 之上：

```js
retry()

processEach()

verify()

judgePanel()

alwaysSuccess()

repeat()
```

比如：

```js
processEach(items, ...stages)
```

内部甚至直接：

```js
return parallel(
    items.map(item => () =>
        sequence(
            stages.map(stage =>
                prev => stage(prev)
            ),
            { input: item }
        )
    )
)
```

这样 Runtime 架构反而更漂亮。

---

# 10. 但是不要现在直接删除 pipeline()

因为已经有人使用你的 npm 包了。

如果直接从：

```js
pipeline()
```

删除，会造成 Breaking Change。

我建议：

```text
V0.x

pipeline()
↓
继续支持
↓
内部改成
parallel + sequence
```

然后文档：

```text
pipeline() is deprecated.

Use:

processEach()

or:

parallel + sequence
```

后面如果要发：

```text
1.0
```

再正式删除。

---

# 11. Sequence 最终 API，我建议这样

第一步可以：

```js
const result = await sequence([
    () =>
        workflow("01-analyze.js"),

    analysis =>
        workflow("02-design.js", {
            analysis
        }),

    design =>
        workflow("03-develop.js", {
            design
        })
])
```

结果默认：

```text
sequence return = 最后一个成功节点结果
```

因为这最符合：

```text
function composition
```

语义：

```text
A → B → C
        │
        ▼
      result
```

如果需要所有结果：

```js
const result = await sequence(
    [...],
    {
        collect: true
    }
)
```

返回：

```js
{
    value: finalResult,

    results: [
        analysis,
        design,
        develop
    ]
}
```

不过第一版甚至可以不做 `collect`。

因为：

```js
(prev, ctx)
```

已经能访问：

```js
ctx.results
```

---

# 12. 这样 `sequence` 与 `pipeline` 的关系就彻底清楚了

以后：

```text
sequence
```

定义：

> **一组 Node 串行执行，并把前一个 Node 的结果作为后一个 Node 的输入。**

```text
parallel
```

定义：

> **一组 Node 并发执行。**

```text
fallback
```

定义：

> **一组 Node 串行竞争，第一个成功结果返回。**

```text
race
```

定义：

> **一组 Node 并行竞争，第一个成功结果返回。**

然后：

```text
processEach
```

仅仅是：

```text
parallel + sequence
```

的组合 helper。

你会得到一个非常漂亮的模型：

|        | 全部/链式      | 选一个        |
| ------ | ---------- | ---------- |
| **串行** | `sequence` | `fallback` |
| **并行** | `parallel` | `race`     |

而批处理：

```text
processEach
```

就不是第五种控制模型。

它只是：

```text
parallel(
    N × sequence(...)
)
```

---

## 所以我对你两个问题的结论

**数据向下传：**

直接采用：

```js
(prev, ctx) => Node
```

规则：

```text
当前 Node return
        ↓
下一 Node prev

ctx.results
        ↓
访问之前所有结果
```

不要引入隐式全局 state。

**Pipeline 是否取消：**

我赞成**取消它作为 Core Primitive**，但不建议马上删除 API。

更合理的是：

```text
现在

pipeline
parallel
agent
...

          ↓ 重构

Core
├── sequence
├── parallel
├── fallback
└── race

Helper
├── processEach
├── retry
├── verify
└── ...

Compatibility
└── pipeline() → processEach()
```

这样这次改造就不再是“多加几个 PandaBT API”，而是真正在做一次 **Dynamic Workflow 控制流模型收敛**。从长期维护角度看，我认为这比单纯新增 `sequence()` 更有价值。

[1]: https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/workflow.txt?utm_source=chatgpt.com "MiMo-Code/packages/opencode/src/tool/workflow.txt at main · XiaomiMiMo/MiMo-Code · GitHub"
