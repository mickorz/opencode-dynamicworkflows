# Dynamic Workflow Composite Control Flow V1

## 一、这次版本的目标

本次改造目标：

```text
现有 Runtime
agent / workflow / parallel / pipeline
retry / verify / checkpoint
journal / resume / abort
        ↓
增加 Composite Control Layer
        ↓
sequence / fallback
        ↓
后续 race / 更多组合节点
```

核心原则：

```text
Add Composite Layer
Don't Rewrite Runtime
```

本次暂时不做：

```text
.flow DSL
Stable Node ID
Journal 格式重构
Parallel 重写
Pipeline 直接删除
完整 Behavior Tree Tick
random
无限 while / repeat
```

---

# P0 — 必须完成

P0 的目标是：

> 在不破坏任何旧 Workflow 的前提下，把 Composite Node 最小模型建立起来。

---

## P0-0｜创建开发分支 + 冻结当前行为

建议分支：

```bash
git checkout -b feat/composite-control-flow
```

开发前先确保：

```text
main
  ↓
当前所有测试通过
  ↓
记录 baseline
  ↓
再开始修改
```

重点冻结以下现有行为：

```text
agent()
parallel()
pipeline()
workflow()
retry()
checkpoint()
journal
resume
abort
structuredClone
nested workflow
```

当前约定中，`agent()` 可恢复失败返回 `null`，不可恢复错误直接抛出；`parallel()` 保持输入顺序并在失败位置留下 `null`；`pipeline()` 是每个 item 独立依次穿过所有 stage。

### 必须建立 Regression / Golden Tests

至少覆盖：

```text
agent success
agent null
agent throw

parallel all success
parallel partial null
parallel throw

pipeline normal
pipeline stage null
pipeline pure JS stage
pipeline 多 item 并发

workflow child success
workflow child return { ok:false }
workflow child error
workflow cycle
workflow max depth
workflow args clone
workflow return clone

agent resume
checkpoint resume
child workflow resume
child 顺序变化 resume

root abort
child workflow abort
background run
```

### P0-0 验收

```text
✓ 修改任何 Runtime 前全部测试通过
✓ 保存 baseline 输出
✓ 新分支任何后续提交都必须继续通过旧测试
```

---

# P0-1｜定义 Node Execution Contract

这是整个版本最重要的设计。

不要直接开始写：

```ts
sequence()
```

先解决：

> 什么叫 Node 成功？

内部定义：

```ts
type NodeStatus =
  | "success"
  | "failure"
  | "cancelled"
```

以及：

```ts
interface NodeExecutionResult<T = unknown> {
  status: NodeStatus
  value?: T
  error?: unknown
}
```

注意：

```text
Execution Status
≠
Business Result
```

比如：

```js
workflow("verify.js")
```

返回：

```js
{
    ok: false,
    errors: [...]
}
```

仍然应该是：

```text
Execution Status = success

Business Result = { ok:false }
```

当前 child workflow 正常 return 即 runtime 成功，业务层 `{ok:false}` 不会改变运行状态，这个契约必须保留。

### 禁止

不要：

```ts
if (!value)
    failure
```

因为：

```text
null
false
0
""
{ ok:false }
```

不是同一个概念。

### Public API 暂时不变

仍然：

```js
const result = await agent(...)
```

而不是突然改成：

```js
const result = await agent(...)

result.status
result.value
```

NodeResult 第一阶段只存在于：

```text
Runtime Internal
```

不能破坏旧 API。

---

# P0-2｜实现统一 Node Executor

新增一个内部抽象：

```ts
type WorkflowNode<TPrev = unknown, TResult = unknown> =
    (previous: TPrev) =>
        TResult | Promise<TResult>
```

以及：

```ts
executeNode(node, input)
```

职责只包括：

```text
调用 Node
捕获 Runtime failure
传播 structural error
识别 cancellation
包装 NodeExecutionResult
```

不负责：

```text
创建 agent
journal agent
token 统计
semaphore
worktree
structuredClone
TUI
```

架构：

```text
Composite
    ↓
executeNode()
    ↓
现有 API

agent()
workflow()
parallel()
...
```

---

# P0-3｜实现 sequence()

第一版核心 API：

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

数据规则：

```text
Node A return
      ↓
Node B prev
      ↓
Node B return
      ↓
Node C prev
```

最终：

```text
sequence return
=
最后一个成功 Node 的 value
```

### Sequence 执行规则

```text
SUCCESS
↓
执行下一个

FAILURE
↓
立即停止
↓
sequence failure

CANCELLED
↓
立即停止
↓
向上传递 cancelled

Structural Error
↓
直接 throw
```

例如：

```text
unknown workflow
cycle
max depth
非法参数
Runtime invariant error
```

不能被 sequence 当普通 Failure 吞掉。

### 必须支持

```js
sequence([
    () => agent(...),

    prev => workflow("xxx.js", {
        input: prev
    }),

    prev => parallel([
        () => agent(...),
        () => workflow("yyy.js")
    ])
])
```

即 Sequence 接受：

```text
任意 async Node
```

而不是：

```text
Agent[]
```

---

# P0-4｜Sequence + Child Workflow 集成测试

这是第一版最重要的 integration test。

测试：

```js
await sequence([
    () => workflow("child-a.js"),

    a => workflow("child-b.js", {
        a
    }),

    b => workflow("child-c.js", {
        b
    })
])
```

验证：

```text
child args 仍 structuredClone
child return 仍 structuredClone

child depth 正常
cycle detection 正常

父子共享 maxAgents
父 abort 能终止 child

workflowPath 不变
workflowScopePath 不变
```

当前原生子 workflow 已经规定：父子共享并发配额、中断、journal 与统计；args 和返回值通过 `structuredClone` 隔离。

Sequence 不得破坏这些规则。

---

# P0-5｜Journal / Resume 兼容

第一版非常重要：

```text
sequence 本身
不要占 agent/checkpoint journal callIndex
```

例如旧：

```js
await agent("A")
await agent("B")
```

Journal：

```text
0 A
1 B
```

改成：

```js
await sequence([
    () => agent("A"),
    () => agent("B")
])
```

仍然应该让：

```text
A
B
```

按照现有 Agent Journal 规则记录。

不能变成：

```text
0 sequence
1 A
2 B
```

当前 resume 是位置匹配：首个变化调用及之后重新执行；child workflow 又通过 `wfK` 调用顺序寻址。

### 第一版接受的限制

如果控制分支发生变化：

```text
之后的 journal miss
↓
重新执行
```

可以接受。

暂时不要实现：

```text
Branch-aware resume
Stable node IDs
Content-addressed journal
```

---

# P0-6｜实现 fallback()

完成 Sequence 后再做。

API：

```js
const result = await fallback([
    () => workflow("fast.js"),

    () => workflow("strong.js"),

    () => workflow("last-resort.js")
])
```

规则：

```text
Node A success
→ 返回 A
→ 后续不执行

Node A failure
→ 尝试 B

A/B/C 全 failure
→ fallback failure
```

### 最关键规则

以下情况：

```text
Runtime recoverable failure
```

可以进入下一候选。

以下情况：

```text
unknown workflow
cycle
max depth
invalid Node
Runtime bug
```

必须：

```text
throw
```

不能被 fallback 吞掉。

否则：

```js
fallback([
    () => workflow("拼错的名字.js"),
    () => workflow("backup.js")
])
```

会把编程错误伪装成正常降级。

---

# P0-7｜P0 回归测试

P0 完成后必须跑：

```text
旧 API Regression
+
Composite Unit Test
+
Composite Integration Test
+
Resume Test
+
Nested Workflow Test
```

重点比较：

```text
旧 Workflow
VS
使用 sequence 重写后的 Workflow
```

验证：

```text
最终结果一致
agent 数一致
token 统计一致
child 统计一致
journal 可恢复
abort 正常
structuredClone 正常
```

---

# P0 完成标准

只有下面全部满足才能进入 P1：

```text
✓ 旧测试 100% 通过
✓ agent Public API 无变化
✓ parallel 行为无变化
✓ pipeline 行为无变化
✓ workflow 行为无变化

✓ sequence 支持 agent
✓ sequence 支持 workflow
✓ sequence 支持 parallel
✓ sequence 数据 prev 传递

✓ fallback 可组合

✓ resume 没有明显 regression
✓ nested workflow 没有 regression
```

---

# P1 — 核心能力扩展

P1 的目标是：

> Composite 模型已经稳定后，再增加真正的新 Orchestration 能力。

---

## P1-1｜把现有 parallel 纳入 Node 模型

注意：

```text
不是重写 parallel
```

而是：

```text
Composite Layer
      ↓
existing parallel()
```

让它可以作为 Node：

```js
await sequence([
    analyze,

    () => parallel([
        client,
        server,
        ui
    ]),

    review
])
```

保持当前行为：

```text
输出顺序保持
失败槽位 null
共享 maxAgents
```

当前 `parallel()` 已经有稳定并发和失败占位语义，不值得在这次顺手重写。

---

## P1-2｜实现 race()

API：

```js
const result = await race([
    () => workflow("model-a.js"),
    () => workflow("model-b.js"),
    () => workflow("model-c.js")
])
```

语义：

```text
First SUCCESS wins
```

不是：

```text
First settled wins
```

即：

```text
A failure
B success  ← winner
C running
```

结果：

```text
返回 B
取消 C
```

---

## P1-3｜实现 Composite Local Abort Scope

这是 race 的前置条件。

需要：

```text
Root AbortController
        │
        ├ Composite Scope
        │      ├ A
        │      ├ B
        │      └ C
        │
        └ 后续 Workflow
```

race winner 后：

```text
abort siblings
```

不能：

```text
abort root workflow
```

测试：

```text
race agent + agent
race workflow + workflow
race nested workflow
root abort during race
winner 后 loser cleanup
```

---

## P1-4｜Pipeline 等价性 A/B Test

这个阶段**仍然不要删 pipeline**。

当前 pipeline 的正式语义是：

```text
每个 item 依次经过所有 stage
不同 item 之间并发
stage(previousValue, originalItem, index)
```

并允许纯 JS stage。

建立：

```text
Old

pipeline(
    items,
    A,
    B,
    C
)
```

和：

```text
New

parallel(
    items.map(item => () =>
        sequence([
            () => A(item),
            prev => B(prev),
            prev => C(prev)
        ])
    )
)
```

的 A/B。

重点比较：

```text
结果
null 行为
异常行为
执行顺序
并发峰值
wall time
agent 调用顺序
journal 顺序
resume
内存
abort
```

### 特别关注

旧 Pipeline：

```text
Stage A 返回 null
↓
后续 Stage 是否继续
```

与：

```text
sequence null 是否视为 failure
```

可能不一致。

这个问题不解决：

```text
禁止 deprecated pipeline
```

---

## P1-5｜LLM Workflow Generation A/B

这是你这个项目非常重要的一项。

准备相同的 20~50 个 Workflow Prompt：

```text
简单串行
串行 + parallel
失败 fallback
nested workflow
复杂组合
```

A：

```text
旧 workflow-authoring skill
```

B：

```text
Composite API skill
```

比较：

```text
首次运行成功率
语法错误率
控制流错误率
平均脚本长度
修复轮数
输入 token
输出 token
人工可读性
```

如果 Composite API 没有明显提升：

```text
不要继续扩 DSL
```

---

## P1-6｜更新 Authoring Skill

这时候才让 Main Agent 学习：

```js
sequence()
fallback()
parallel()
race()
```

但是规则必须写清楚：

简单：

```js
const a = await A()
const b = await B(a)
```

继续允许普通 JS。

不要机械地：

```text
所有 await
↓
全部 sequence
```

Composite 主要用于：

```text
结构化控制流
嵌套组合
fallback
race
复杂 orchestration
```

---

# P1 完成标准

```text
✓ sequence / parallel / fallback / race 可组合
✓ race sibling cancellation 正确
✓ root abort 正常
✓ nested workflow 正常

✓ Pipeline A/B 有完整报告
✓ LLM Generation A/B 有结果

✓ Skill 开始推荐 Composite
```

---

# P2 — 产品化与清理

P2 不影响核心能力，可以等 P0/P1 稳定后做。

---

## P2-1｜决定 Pipeline 去留

根据 P1 A/B 决定：

### 如果完全等价

将：

```text
pipeline
```

从：

```text
Core Primitive
```

降级成：

```text
Convenience Helper
```

内部可逐步实现为：

```text
parallel + sequence
```

然后：

```text
pipeline()
→ deprecated
```

但暂时保持兼容。

未来 Major Version 再删除。

### 如果存在明显语义优势

继续保留：

```text
pipeline
```

尤其是：

```text
流式调度
大量 item
特殊 null propagation
资源效率
```

存在优势时，没有必要为了 API 漂亮强行删除。

---

## P2-2｜考虑 processEach()

如果 Pipeline 的核心需求仍然存在，可以把语义更明确地命名为：

```js
processEach(items, ...stages)
```

强调：

```text
对每个 Item 运行处理链
```

而不是把它理解成普通：

```text
A → B → C
```

---

## P2-3｜Composite TUI Tree

Runtime 稳定后再增加：

```text
▼ Sequence
  ✓ Analyze

  ▼ Parallel
    ✓ Client
    ✓ Server

  ▼ Fallback
    ✗ Fast
    ✓ Strong
```

第一阶段只做显示。

不要为了 TUI：

```text
改变 journal addressing
```

Composite metadata 可以另外记录。

---

## P2-4｜更多 PandaBT 风格节点

再评估：

```text
repeat
guard
invert
alwaysSuccess
```

优先级：

```text
repeat        P2
guard         P2
invert        P2
alwaysSuccess P2
```

暂时不要：

```text
random
无限 while
复杂 decorator
```

---

## P2-5｜Stable Node ID 调研

这可以作为下一阶段独立设计。

目标：

```text
Position-based resume

        ↓

Stable Node ID based resume
```

例如：

```text
develop.frontend
develop.backend
review.verify
```

但这会影响：

```text
journal
resume
TUI
workflow scope
```

所以不能塞进这次 V1。

---

# 最终 Core Model

这次改造完成后，希望 Runtime 核心收敛成：

```text
                     Node
                      │
          ┌───────────┴────────────┐
          │                        │
         Leaf                  Composite
          │                        │
      ┌───┴────┐       ┌──────────┼──────────┐
    agent   workflow   sequence  parallel
                               
                         ┌─────────┴─────────┐
                      fallback             race
```

可以进一步理解成：

```text
                ALL          SELECT ONE

SERIAL       sequence         fallback

PARALLEL     parallel         race
```

这是这次改造最值得保留下来的统一心智模型。

---

# 推荐 Commit 拆分

为了方便回滚，不要做成一个大 Commit：

```text
1. test: freeze runtime behavioral baseline

2. refactor: add internal node execution protocol

3. feat: add sequence composite node

4. test: add sequence nested-workflow coverage

5. feat: add fallback composite node

6. test: add composite resume regression coverage

---------------- P0 TAG ----------------

7. refactor: integrate existing parallel with node abstraction

8. feat: add scoped cancellation infrastructure

9. feat: add race composite node

10. test: add race cancellation and nested workflow tests

11. test: add pipeline equivalence benchmark

12. docs: update workflow authoring guidance

---------------- P1 TAG ----------------

13. feat: add composite tree observability

14. refactor/docs: decide pipeline helper/deprecation strategy

15. feat: add optional composite helpers
```

---

# 开发过程中的三条红线

### 红线 1

不要修改：

```text
agent() Public Return Type
```

### 红线 2

不要在 P0 修改：

```text
journal addressing
wfN addressing
parallel scheduling
pipeline implementation
```

### 红线 3

发现：

```text
为了实现 sequence
必须同时重构 5 个现有模块
```

立即缩范围。

这说明 Composite Layer 已经侵入 Engine。

正确方向应该始终是：

```text
         New Composite Layer
                  │
                  ▼
         Existing Runtime APIs
                  │
      ┌───────────┼────────────┐
      ▼           ▼            ▼
    agent      workflow     parallel
                  │
                  ▼
         journal / resume
```

而不是：

```text
sequence
↓
重新实现
agent / parallel / journal / workflow
```

---

# 开发顺序总结

```text
P0
│
├── Freeze Regression
├── Node Contract
├── executeNode
├── sequence
├── child workflow
├── resume compatibility
└── fallback
        ↓
       TAG

P1
│
├── parallel integration
├── local abort scope
├── race
├── pipeline A/B
├── LLM generation A/B
└── skill update
        ↓
       TAG

P2
│
├── Pipeline 去留
├── processEach
├── Composite TUI
├── repeat / guard / invert
└── Stable Node ID 调研
```

**当前开始开发时，只盯着 P0。P0 完成且 Regression 全绿以后，再开始 race 和 pipeline 重构。**
