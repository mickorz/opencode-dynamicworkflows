# Dynamic Workflow Composite Control Flow V1 开发计划

## 一、版本目标

本次开发的核心目标不是单纯增加 PandaBT 风格节点，而是给现有 Dynamic Workflow 增加一层统一的：

> **Composite Control Flow**

整体演进：

```text
现有 Runtime

agent
workflow
parallel
pipeline
retry
verify
checkpoint
journal / resume
abort
        │
        ▼
新增 Composite Layer
        │
        ├── sequence
        ├── fallback
        ├── parallel
        └── race
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

# 二、成功判定模型

这次 Composite 开发必须先统一一个原则：

```text
Execution Success
≠
Task Success
≠
Quality Success
≠
Human Approval
```

后续形成四层验证体系：

```text
Level 1
Execution
──────────────
agent / workflow

        ↓

Level 2
Deterministic Validation
────────────────────────
check / compile / test

        ↓

Level 3
AI Quality Validation
─────────────────────
verify

        ↓

Level 4
Human Approval
──────────────
checkpoint
```

职责：

| Node           | 作用      | 判断者     |
| -------------- | ------- | ------- |
| `agent()`      | 执行任务    | Runtime |
| `check()`      | 确定性事实检查 | 程序 / 工具 |
| `verify()`     | 语义、质量验证 | LLM     |
| `checkpoint()` | 人工授权    | Human   |

其中：

```text
verify()
```

当前已经存在，本次不重新开发。

```text
checkpoint()
```

当前已经存在，本次重点做 Composite 集成。

```text
check()
```

当前作为 P1 新能力开发。

---

# P0 — Composite 基础能力

P0 的目标：

> 在旧 Workflow 行为零回归的情况下，建立 Composite 最小可用模型。

P0 完成后应至少具备：

```text
sequence
fallback
child workflow composition
verify integration
checkpoint integration
journal / resume compatibility
```

---

## P0-0｜创建开发分支

建议：

```bash
git checkout -b feat/composite-control-flow
```

开发前：

```text
main
 ↓
全量测试通过
 ↓
记录当前行为 baseline
 ↓
开始修改
```

---

# P0-1｜冻结现有 Runtime 行为

首先建立 Behavioral Golden Tests。

需要冻结：

```text
agent()
parallel()
pipeline()
workflow()
retry()
verify()
checkpoint()
journal
resume
abort
structuredClone
nested workflow
```

重点测试：

```text
agent success
agent recoverable failure
agent throw
agent abort

parallel success
parallel partial failure
parallel order

pipeline normal
pipeline stage null
pipeline pure JS stage
pipeline multi-item concurrency

workflow child success
workflow child error
workflow child return { ok:false }

workflow cycle
workflow max depth
workflow args clone
workflow return clone

verify success / failure

checkpoint approve
checkpoint reject
checkpoint resume

agent resume
checkpoint resume
child workflow resume

root abort
child abort

background execution
```

### P0-1 验收

```text
✓ 所有当前行为有测试保护
✓ baseline 全绿
✓ 后续所有 Commit 必须保持旧测试通过
```

---

# P0-2｜定义 Node Execution Contract

内部新增统一 Node 状态：

```ts
type NodeStatus =
  | "success"
  | "failure"
  | "cancelled"
```

内部：

```ts
interface NodeExecutionResult<T = unknown> {
  status: NodeStatus
  value?: T
  error?: unknown
}
```

必须严格区分：

```text
Execution Status
```

和：

```text
Business Result
```

例如：

```js
return {
  ok: false,
  errors: [...]
}
```

只要 Workflow 正常 return：

```text
Execution Status = success
```

不能简单：

```ts
if (!result)
  failure
```

因为：

```text
false
0
""
null
{ ok:false }
```

不能全部等价处理。

---

# P0-3｜保持 Public API 兼容

不要把现有：

```js
const result = await agent(...)
```

改成：

```js
const result = await agent(...)

result.status
result.value
```

NodeExecutionResult 第一版属于：

```text
Runtime Internal Protocol
```

不是 Public API。

保持现有：

```text
agent()
workflow()
verify()
checkpoint()
```

返回形式不变。

---

# P0-4｜实现统一 executeNode()

新增内部：

```ts
type WorkflowNode<TPrev = unknown, TResult = unknown> =
  (
    previous: TPrev
  ) => TResult | Promise<TResult>
```

以及：

```ts
executeNode(node, input)
```

职责：

```text
执行 Node
转换 Runtime execution status
传播 cancellation
包装 NodeExecutionResult
传播 structural error
```

不负责：

```text
创建 Agent
token 统计
journal agent entry
concurrency semaphore
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
Existing Runtime APIs
```

---

# P0-5｜实现 sequence()

第一版：

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

数据流：

```text
Node A result
      ↓
Node B prev
      ↓
Node B result
      ↓
Node C prev
```

默认：

```text
sequence result
=
最后一个成功 Node 的 value
```

---

## Sequence 状态规则

```text
SUCCESS
↓
继续下一个 Node

FAILURE
↓
立即停止
↓
sequence FAILURE

CANCELLED
↓
立即停止
↓
向上传播

Structural Error
↓
throw
```

Structural Error 例如：

```text
unknown workflow
cycle
max depth
invalid node
runtime invariant error
```

不能作为普通 failure 被吞掉。

---

# P0-6｜Sequence 支持任意 Node

必须支持：

```js
sequence([
  () => agent(...),

  prev => workflow("child.js", {
    input: prev
  }),

  prev => parallel([
    () => agent(...),
    () => workflow(...)
  ])
])
```

设计原则：

> sequence 不认识 Agent、Workflow、Parallel。

它只认识：

```text
Node
```

---

# P0-7｜Sequence + Child Workflow

重点集成测试：

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
child args structuredClone 保持
child return structuredClone 保持

max depth 保持
cycle detection 保持

共享 concurrency 保持
父 abort → child abort 保持

workflowPath 保持
workflowScopePath 保持
```

Composite 不得绕过现有 `workflow()` 边界。

---

# P0-8｜verify() Composite 集成

`verify()` 已经存在。

本次：

```text
不重写
不改变 API
不改变返回结构
```

只需要保证它可以作为 Composite Node 使用。

例如：

```js
await sequence([
  () =>
    agent("实现登录超时功能"),

  result =>
    verify(result, {
      reviewers: 2,
      lens: "检查是否完整满足登录超时需求"
    }),

  () =>
    workflow("next.js")
])
```

但必须明确：

```text
verify
=
AI Semantic / Quality Validation
```

它不用于判断：

```text
文件是否存在
文件是否真的修改
编译是否成功
测试是否通过
```

这些留给未来的：

```text
check()
```

或者具体工具 Workflow。

---

# P0-9｜checkpoint() Composite 集成

checkpoint 提升为 P0 核心能力。

目标：

> 让 Human-in-the-loop 成为 Composite Workflow 的一等节点。

典型：

```js
await sequence([
  () =>
    agent("修改代码"),

  () =>
    workflow("compile.js"),

  result =>
    verify(result, {
      reviewers: 2
    }),

  () =>
    checkpoint(
      "代码已修改并通过验证，是否继续？"
    ),

  () =>
    workflow("publish.js")
])
```

执行：

```text
Agent
 ↓
Compile
 ↓
Verify
 ↓
Checkpoint
 ↓
Human Approve
 ↓
Publish
```

---

## Checkpoint 状态语义

当前 Public API 保持不变。

内部语义：

```text
Approve
→ SUCCESS

Reject
→ STOP

Abort
→ CANCELLED
```

第一版不一定需要公开：

```text
REJECTED
```

这个新 NodeStatus。

但 Runtime 内部必须区分：

```text
普通 Failure
```

和：

```text
Human Reject
```

因为 Human Reject 不应该默认触发自动降级。

---

## Human Reject 默认行为

例如：

```js
sequence([
  () => agent("修改代码"),

  () => checkpoint("是否接受？"),

  () => workflow("deploy.js")
])
```

用户 Reject：

```text
Modify
 ↓
Checkpoint
 ↓
Reject
 ↓
STOP
```

Deploy 不执行。

---

## Human Reject 与 fallback

默认不要：

```text
Human Reject
↓
自动进入 fallback
```

例如：

```js
fallback([
  () => checkpoint(...),
  () => alternative()
])
```

不能默认理解成：

```text
用户不同意
→ 系统自己换方案继续
```

设计原则：

> Human rejection 默认具有强停止语义。

以后如果真有需求，再显式支持：

```text
onReject
```

---

# P0-10｜Checkpoint Resume

这是 P0 高风险重点。

场景：

```text
Agent A
 ↓
Checkpoint
 ↓
Human Approve
 ↓
程序退出
```

Resume 后：

```text
不能再次弹同一个 Checkpoint。
```

应该：

```text
checkpoint request
 ↓
Human approve
 ↓
journal approval
 ↓
restart
 ↓
resume
 ↓
复用 approval
 ↓
继续
```

必须测试：

```text
Approve → restart → resume

Reject → restart → resume

waiting 状态 abort

nested workflow checkpoint

sequence → workflow → checkpoint

checkpoint → child workflow
```

---

# P0-11｜Journal / Resume Compatibility

Composite 第一版：

```text
不要占现有 Agent / Checkpoint callIndex
```

例如：

```js
await agent("A")
await agent("B")
```

和：

```js
await sequence([
  () => agent("A"),
  () => agent("B")
])
```

不能因为多了一层 `sequence`：

```text
0 sequence
1 A
2 B
```

而改变旧 Journal addressing。

应该仍由真正执行节点记录。

Composite：

```text
transparent to journal addressing
```

第一版接受：

```text
分支发生变化
↓
该位置之后 resume cache 失效
↓
重新执行
```

暂时不做：

```text
Stable Node ID
Branch-aware resume
Content-addressed journal
```

---

# P0-12｜实现 fallback()

API：

```js
const result = await fallback([
  () => workflow("fast.js"),
  () => workflow("strong.js"),
  () => workflow("backup.js")
])
```

规则：

```text
A SUCCESS
→ 返回 A
→ STOP

A FAILURE
→ B

A + B FAILURE
→ C

全部 FAILURE
→ fallback FAILURE
```

Structural Error：

```text
unknown workflow
cycle
max depth
invalid node
runtime bug
```

必须：

```text
throw
```

不能：

```text
自动 fallback
```

---

# P0-13｜验证 + 人工批准组合模式

P0 完成后必须支持：

```js
await sequence([
  () =>
    agent("修改 PlayerController.cs"),

  () =>
    workflow("compile.js"),

  result =>
    verify(result, {
      reviewers: 2,
      lens: "检查代码修改质量"
    }),

  () =>
    checkpoint(
      "是否接受此次修改并继续？"
    ),

  () =>
    workflow("next-stage.js")
])
```

形成：

```text
AI Execute
    ↓
Machine Check
    ↓
AI Review
    ↓
Human Gate
    ↓
Continue
```

其中 Machine Check 第一版可以通过：

```text
compile workflow
test workflow
```

完成。

通用：

```text
check()
```

在 P1 加入。

---

# P0-14｜P0 Regression

必须执行：

```text
Existing Runtime Regression
+
Sequence Unit Tests
+
Fallback Unit Tests
+
Nested Workflow Tests
+
Verify Integration Tests
+
Checkpoint Integration Tests
+
Journal / Resume Tests
+
Abort Tests
```

---

# P0 完成标准

必须全部满足：

```text
✓ 所有旧测试通过

✓ agent API 不变
✓ workflow API 不变
✓ parallel 行为不变
✓ pipeline 行为不变
✓ verify API 不变
✓ checkpoint API 不变

✓ sequence 支持 agent
✓ sequence 支持 workflow
✓ sequence 支持 parallel
✓ sequence 支持 verify
✓ sequence 支持 checkpoint

✓ prev 数据正常传递

✓ fallback 正常组合

✓ checkpoint approve 正常继续
✓ checkpoint reject 正常停止
✓ checkpoint resume 不重复询问

✓ nested workflow 无回归
✓ journal/resume 无明显回归
```

达到这里可以打：

```text
Composite V1 P0
```

内部测试版本。

---

# P1 — Composite 能力扩展

P1 目标：

> Composite 模型稳定后，再增加新 Orchestration 和确定性验证能力。

---

# P1-1｜新增 check()

新增：

```js
check()
```

职责：

```text
Deterministic Validation
```

第一版：

```ts
async function check(
  condition: () =>
    boolean | Promise<boolean>,

  message?: string
)
```

例如：

```js
await check(
  () =>
    fileChanged("src/login.ts"),

  "src/login.ts was not modified"
)
```

规则：

```text
true
→ SUCCESS

false
→ FAILURE

throw
→ structural/runtime error
```

---

## check() 在 sequence 中

```js
await sequence([
  () =>
    agent("修改 src/login.ts"),

  () =>
    check(
      () => fileChanged("src/login.ts")
    ),

  () =>
    workflow("compile.js")
])
```

---

## check / verify / checkpoint 职责固定

```text
check
→ 客观事实

verify
→ AI 质量判断

checkpoint
→ 人工决定
```

不要互相代替。

---

# P1-2｜把现有 parallel 纳入 Composite Node Model

不是重写。

而是：

```text
Composite Layer
 ↓
Existing parallel()
```

支持：

```js
sequence([
  analyze,

  () => parallel([
    client,
    server,
    ui
  ]),

  review
])
```

保持现有：

```text
input order
null slot
maxAgents
concurrency behavior
```

---

# P1-3｜实现 race()

API：

```js
const result = await race([
  () => workflow("model-a.js"),
  () => workflow("model-b.js"),
  () => workflow("model-c.js")
])
```

规则：

```text
First SUCCESS wins
```

不是：

```text
First settled wins
```

例如：

```text
A FAILURE
B SUCCESS ← Winner
C RUNNING
```

结果：

```text
返回 B
取消 C
```

---

# P1-4｜Composite Local Abort Scope

race 需要局部取消：

```text
Root AbortController
      │
      ├── Race Scope
      │     ├── A
      │     ├── B
      │     └── C
      │
      └── 后续 Workflow
```

Winner 出现：

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
winner cleanup
```

---

# P1-5｜Pipeline A/B

此阶段仍然保留原 `pipeline()`。

比较：

```js
pipeline(
  items,
  A,
  B,
  C
)
```

与：

```js
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

比较：

```text
output
null behavior
error behavior
execution order
peak concurrency
wall time
journal order
resume
abort
memory
```

如果语义不完全等价：

```text
pipeline 暂不废弃
```

---

# P1-6｜LLM Workflow Generation A/B

准备：

```text
20~50 个 Workflow Prompt
```

覆盖：

```text
简单串行
parallel
fallback
nested workflow
verify
checkpoint
check
race
复杂 Composite
```

比较旧 Skill 与新 Composite Skill：

```text
首次成功率
控制流错误率
脚本长度
修复轮数
token
人工可读性
```

---

# P1-7｜更新 Workflow Authoring Skill

规则：

简单情况：

```js
const a = await A()
const b = await B(a)
```

继续允许普通 JS。

Composite 主要用于：

```text
复杂控制流
nested composition
fallback
race
structured sequence
human gate
```

不要把所有：

```text
await A()
await B()
```

机械改成 `sequence()`。

---

# P1 完成标准

```text
✓ sequence / parallel / fallback / race 可组合

✓ check 可作为 Node

✓ verify 与 check 职责分离

✓ checkpoint Human Gate 稳定

✓ race sibling cancellation 正常

✓ Pipeline A/B 有报告

✓ LLM Generation A/B 有报告

✓ Skill 更新完成
```

---

# P2 — 产品化与进一步收敛

---

## P2-1｜决定 Pipeline 去留

如果 P1 A/B 证明：

```text
parallel + sequence
```

可以完全覆盖：

```text
pipeline
```

那么将 pipeline 从：

```text
Core Primitive
```

降级成：

```text
Convenience Helper
```

后续：

```text
Deprecated
```

Major Version 再考虑删除。

如果 pipeline 在：

```text
大量 item
流式调度
特殊 null propagation
性能
内存
```

仍明显有优势：

```text
继续保留
```

---

# P2-2｜processEach()

如果批处理需求继续存在，可以考虑：

```js
processEach(items, ...stages)
```

替代语义较模糊的：

```js
pipeline()
```

强调：

> 每个 Item 执行独立处理链。

---

# P2-3｜Deterministic Helper

在 `check()` 上建立：

```text
fileExists()
fileChanged()
commandSuccess()
schemaValid()
compilePassed()
testsPassed()
```

这些不是 Core Composite Primitive。

而是：

```text
check() convenience helpers
```

---

# P2-4｜Composite TUI

目标：

```text
▼ Sequence

  ✓ Analyze

  ▼ Parallel
    ✓ Client
    ✓ Server

  ✓ Check
      Compile passed

  ✓ Verify
      2/2 reviewers passed

  ⏸ Checkpoint
      Waiting for human approval...

  ○ Deploy
```

Checkpoint 必须清晰显示：

```text
Waiting
Approved
Rejected
Cancelled
```

让用户能区分：

```text
Workflow 卡死
```

和：

```text
Workflow 正在等待人工操作
```

---

# P2-5｜更多节点

再考虑：

```text
repeat
guard
invert
alwaysSuccess
```

暂不做：

```text
random
无限 while
复杂 BT decorator
```

---

# P2-6｜Stable Node ID 调研

未来考虑：

```text
Position-based Resume
        ↓
Stable Node ID Resume
```

例如：

```text
develop.client
develop.server
verify.code
approval.release
```

但这是：

```text
Journal / Resume V2
```

单独设计，不塞进 Composite V1。

---

# 三、最终 Core Model

希望最终收敛为：

```text
                      Node
                       │
          ┌────────────┴─────────────┐
          │                          │
         Leaf                    Composite
          │                          │
   ┌──────┼────────┐       ┌─────────┼─────────┐
 agent  workflow  check   sequence  parallel
 verify checkpoint
                            │
                       ┌────┴────┐
                    fallback   race
```

其中：

```text
               ALL         SELECT ONE

SERIAL      sequence         fallback

PARALLEL    parallel         race
```

验证体系：

```text
agent / workflow
      ↓
Execution

check
      ↓
Deterministic Validation

verify
      ↓
AI Quality Validation

checkpoint
      ↓
Human Approval
```

---

# 四、推荐 Commit 拆分

```text
1. test: freeze runtime behavioral baseline

2. refactor: add internal node execution protocol

3. feat: add sequence composite node

4. test: add sequence nested-workflow coverage

5. test: add verify composite integration

6. test: add checkpoint composite integration

7. test: add checkpoint resume coverage

8. feat: add fallback composite node

9. test: add composite resume regression coverage

---------------- P0 TAG ----------------

10. feat: add deterministic check node

11. refactor: integrate existing parallel with node abstraction

12. refactor: add scoped cancellation infrastructure

13. feat: add race composite node

14. test: add race cancellation tests

15. test: add pipeline equivalence benchmark

16. test: add LLM generation A/B benchmark

17. docs: update workflow authoring skill

---------------- P1 TAG ----------------

18. feat: add composite tree observability

19. refactor/docs: decide pipeline strategy

20. feat: add deterministic check helpers

21. research: stable node id / resume v2
```

---

# 五、开发红线

## 红线 1

不要修改现有：

```text
agent() Public Return Type
verify() Public API
checkpoint() Public API
```

---

## 红线 2

P0 不修改：

```text
journal addressing
wfN addressing
parallel scheduler
pipeline implementation
```

---

## 红线 3

Composite 不重新实现：

```text
agent
workflow
journal
concurrency
structuredClone
```

必须：

```text
Composite
 ↓
Existing Runtime
```

---

## 红线 4

Human Reject：

```text
不能默认等价为普通 failure
```

尤其不能让：

```text
checkpoint reject
```

被 `fallback()` 自动吞掉并继续执行其他方案。

---

## 红线 5

不要让 Runtime 通过自然语言判断成功。

禁止类似：

```text
"已完成"
"修改成功"
"done"
```

作为成功判定。

---

# 六、最终开发顺序

```text
P0
│
├─ Freeze Existing Behavior
├─ Node Execution Contract
├─ executeNode
├─ sequence
├─ child workflow
├─ verify integration
├─ checkpoint integration
├─ checkpoint resume
├─ journal compatibility
└─ fallback
      ↓
 Composite V1 P0

P1
│
├─ check
├─ parallel integration
├─ local abort scope
├─ race
├─ pipeline A/B
├─ LLM Generation A/B
└─ skill update
      ↓
 Composite V1 P1

P2
│
├─ pipeline 去留
├─ processEach
├─ deterministic helpers
├─ Composite TUI
├─ repeat / guard / invert
└─ Stable Node ID 调研
```

## 当前开发重点

现在切开发分支后，先只完成：

```text
P0
```

其中第一里程碑：

```text
sequence
+
child workflow
+
verify
+
checkpoint
+
fallback
+
旧 Runtime 零回归
```

达到这个状态后再开始 `check / race / pipeline` 改造。
