**You:**

spec-clarify-workflow-v3-返回约束优化改动说明.md

这个返回约束 真的有用吗

* * *

**ChatGPT:**

有用，而且从你这份 v2→v3 数据看，**大概率确实产生了明显效果**。但我会把文档里的“方案 F 返回硬约束”改成更准确的名字：

> **返回软约束 / Return Contract**
> 
> 它对模型行为很有效，但它并不是真正意义上的“硬约束”。

你这次最有说服力的证据不是总耗时从 1912.7s 降到 1140.6s，而是**同模型、同阶段的对照**。split 组一直用同一个模型，却从最慢 465.9s 降到 135.1s；extract 组也没有换模型，最慢从 856.2s 降到 293.8s。文档自己也指出，summary 换模型最多只能解释约 16% 的总收益。

尤其是这种情况很典型：

```
Agent任务：
读取需求
→ 分析
→ 写 spec_basic.md
→ 最终回复

错误：
最终回复又把 spec_basic.md 全文输出一遍

正确：
最终回复：
spec-basic 已完成
```

对于你的 Dynamic Workflow，这个优化非常值得保留。因为**文件已经是 agent 的正式产物，最终回复很多时候只是 workflow 的控制信号**。你文档里的总结“产出走文件、确认走回复”我认为方向完全正确。

不过，有三个地方我建议你不要过度解读。

### 1. 它不是“硬约束”

这是最重要的一点。

你自己数据里已经证明：

* `split-06`：16,239 token
* `extract-play`：25,911 token
* `review-consistency`：95,182 token

也就是说 prompt 已经写了：

> 最终回复必须只有一行  
> 禁止复述

模型依然可能不听。

所以架构上应该理解成：

```
Prompt 返回约束
       ↓
降低模型长回复概率
       ↓
不是安全边界
       ↓
不是 100% 保证
```

我不会把这种能力放到你正在做的 **Agent 权限系统**里当 enforcement。

它属于：

```
Behavior Policy
```

而不是：

```
Runtime Policy
```

这两个要严格分开。

* * *

### 2. 你现在的 token 数据不能完全等同于“最终回复 token”

这里其实很值得注意。

例如你要求：

```
split 完成。
```

理论上最终输出也就几个 token。

但 v3：

```
split-01   7,788
split-03   6,799
split-05   6,414
split-06  16,239
```

说明你 snapshot 里的 `tokens` **很可能统计的是整个 Agent session 消耗**，而不是单纯最终 assistant message。

所以：

```
v2 859k token
v3 339k token
↓
不能直接得出
“少返回了 520k token”
```

它更可能包含：

```
input tokens
+ reasoning
+ tool result
+ assistant intermediate output
+ final response
```

这一点建议你去确认 OpenCode / Dynamic Workflow 记录的 `tokens` 字段具体定义。

因此文档中：

> 总 token -61%，主要因为返回约束

这个方向可能是对的，但**证据链还不够严密**。

反而耗时和异常长回复案例更能支持你的判断。例如 `split-07` 从 62,901 token / 465.9s 降到 100 token / 135.1s，这个案例非常强。

* * *

### 3. “放在 prompt 最后一定更有效”可以保留，但别当成定律

你这里：

```
v2：
执行步骤第 7 条：
完成后只打印 xxx

v3：
...
【返回约束】
最终回复必须只有一行 xxx
禁止复述
```

实际上同时改了 **三个变量**：

```
位置：
中间 → 最后

措辞：
只打印 → 必须只有一行

规则：
无禁止复述 → 明确禁止复述
```

所以现在不能严格说：

> 是因为放到了 prompt 最后，所以 token -68%。

更准确应该说：

> **独立返回约束段 + prompt 尾部位置 + 强措辞 + 明确禁止复述** 的组合显著提高了遵守率。

你的 extract 组从 434,941 降到 137,973 token，确实是很强的工程证据。

* * *

## 但我建议你再往前走一步

你正在做 `opencode-dynamic-workflow`，我认为不要只依赖 prompt：

```
Agent Prompt

【返回约束】
最终回复必须只有一行：xxx
```

最好把它升级成 Workflow Runtime 的一个标准字段。

例如：

```TypeScript
agent({
  prompt: "...",

  output: {
    mode: "signal",
    value: "spec-basic 已完成",
    maxTokens: 32
  }
})
```

或者：

```TypeScript
agent({
  prompt: "...",

  returnPolicy: {
    type: "status-only",
    maxTokens: 32
  }
})
```

再进一步：

```TypeScript
returnPolicy: "discard"
```

表示：

```
Agent:
分析
↓
调用 Write/Edit
↓
文件已经产生

模型最终回复：
xxxx 一大堆

Workflow Runtime:
直接不消费/不保存
```

但这里有一个关键区别：**如果模型已经生成了几万 token，再 discard 就只省上下文污染，不省生成时间和 token 成本。**

因此理想方案应该是：

```
                Return Contract
                       │
            ┌──────────┴──────────┐
            ↓                     ↓
Prompt soft constraint     Runtime/API constraint
"只回复 DONE"              max output tokens = 32
            │                     │
            └──────────┬──────────┘
                       ↓
                  DONE / status
```

这样才真正接近你说的：

> **返回硬约束**

* * *

## 我对你这次改动的评价

| 项目 | 我的评价 |
| --- | --- |
| 返回约束这个思路 | **非常值得保留** |
| 对本次性能提升是否有贡献 | **基本可以确定有，而且贡献很大** |
| -61% token 能否全部归因于它 | **不能完全证明** |
| “prompt 末尾”是否有效 | **很可能有效，但目前是组合变量** |
| 能否称“硬约束” | **不能** |
| 能否作为权限/安全边界 | **绝对不要** |
| 适不适合 Dynamic Workflow 标准化 | **非常适合** |

所以你目前这版我不会删，反而会把它**抽象成 Dynamic Workflow 的标准 `returnPolicy` 能力**。

你现在其实已经碰到了一个很重要的 Agent Workflow 设计原则：

```
Agent Output ≠ Agent Return
```

即：

```
Output
= 真正业务产物
= spec.md / json / code / database

Return
= Workflow 控制信息
= success / failed / summary / structured result
```

你这次优化本质上并不是“小技巧”，而是在把这两个概念分开。对于你后面做 **Dynamic Workflow + Agent 权限控制 + Context Manager**，这个抽象会非常有价值。

* * *

**You:**

这个整理成需求我放到后续dynamic workflow的后续开发计划当中去

* * *

**ChatGPT:**

可以，我建议把它作为 **Dynamic Workflow 后续能力：Agent Return Policy / 返回策略** 来立项，而不是继续作为某个 workflow 里的 prompt 小技巧。你现有 v3 已经证明“产出走文件、返回走控制信号”这个方向有效，但目前仍属于模型侧软约束，后续需求的重点就是把它提升为 Runtime 标准能力。

下面这版可以直接放进你的后续开发计划。

# Dynamic Workflow - Agent Return Policy 返回策略需求

## 1. 需求名称

**Agent Return Policy / Agent 返回策略**

优先级：**P1**

所属模块：

* Dynamic Workflow Runtime
* Agent Execution
* Context Management
* Workflow Observability

* * *

## 2. 背景

当前 Dynamic Workflow 中，Agent 通常同时存在两类输出：

1. **业务产出 Output**
    * Markdown 文件
    * JSON 文件
    * 代码文件
    * Review Report
    * Spec 文件
    * 其他通过 Write / Edit / Tool 产生的持久化结果
2. **Agent Return**
    * Agent 执行结束后的最终回复
    * 当前通常直接进入 Workflow Runtime、日志或上级 Agent 上下文

目前二者没有明确区分。

例如一个 Agent 的真实任务是：

```
读取需求
→ 分析需求
→ 写入 spec_basic.md
→ 完成
```

业务产物已经通过文件写入完成，但 Agent 仍可能在最终回复中再次输出：

```
以下是我整理完成的 spec_basic.md：

# ...
# ...
数万 token
```

导致：

* 重复生成已经写入文件的内容
* 增加 Agent 执行耗时
* 增加 Token 消耗
* 污染父级 Workflow Context
* 增加日志体积
* 并行 Agent 返回大量无意义文本
* 下游 Workflow 解析不稳定

当前通过 Prompt：

```
【返回约束】
最终回复必须只有一行：xxx
禁止复述输出文件内容。
```

可以明显降低该问题。

但 Prompt 约束本质仍然是 **Soft Constraint**，模型存在不遵守的可能，不能视为 Runtime 硬约束。

因此需要在 Dynamic Workflow Runtime 中正式引入 **Agent Return Policy**。

* * *

# 3. 核心设计原则

## 3.1 Agent Output ≠ Agent Return

Dynamic Workflow 必须显式区分：

```
Agent Output
    ↓
真正业务产物
文件 / JSON / Code / DB / Artifact

Agent Return
    ↓
Workflow 控制信息
success / failed / status / structured result
```

即：

```
Output = 工作成果
Return = 工作流通信协议
```

不能默认让 Return 再次承载完整业务成果。

* * *

## 3.2 产出走 Artifact，控制走 Return

推荐原则：

```
大量内容
    ↓
File / Artifact / Structured Storage

少量控制信息
    ↓
Agent Return
```

例如：

```
spec-basic.md
        ↓
文件系统

Agent Return
        ↓
spec-basic 已完成
```

* * *

# 4. 目标

实现统一的 Agent Return Policy，使 Workflow 可以声明：

> 这个 Agent 执行完成后允许返回什么、返回多少、是否进入上下文、是否需要结构化解析。

主要目标：

1. 减少无意义长回复。
2. 降低 Token 消耗。
3. 降低 Agent latency。
4. 避免父级 Context 被子 Agent 输出污染。
5. 提升 Workflow 返回格式稳定性。
6. 为 Agent 间通信建立统一协议。
7. 为后续 Context Manager 提供标准接口。
8. 为 Agent Runtime 提供真正可执行的返回限制能力。

* * *

# 5. 非目标

Return Policy 不负责：

* 文件系统权限控制
* Agent Read / Write 权限控制
* Tool 调用权限
* Skill 权限
* Prompt Injection 安全防护

这些属于：

```
Runtime Permission Policy
```

Return Policy 属于：

```
Agent Communication / Context Policy
```

二者不能混用。

* * *

# 6. Return Policy 类型

第一版至少支持以下模式。

## 6.1 `full`

保持当前行为。

```
returnPolicy: {
  type: "full"
}
```

含义：

```
完整保留 Agent Final Response
```

适用：

* 普通对话型 Agent
* 调研 Agent
* 需要将完整分析交给父 Agent 的任务

* * *

## 6.2 `status-only`

Agent 只需要返回执行状态。

```
returnPolicy: {
  type: "status-only"
}
```

例如：

```
DONE
```

或者：

```
spec-basic 已完成
```

适用：

* 写文件型 Agent
* 执行脚本型 Agent
* 修改代码型 Agent
* Artifact Producer

推荐默认配合：

```
maxOutputTokens: 32
```

* * *

## 6.3 `signal`

允许 Workflow 定义固定返回值。

```
returnPolicy: {
  type: "signal",
  value: "spec-basic 已完成"
}
```

Agent 完成以后只允许产生：

```
spec-basic 已完成
```

Workflow 可直接消费该信号。

* * *

## 6.4 `structured`

只允许返回规定 Schema。

例如：

```
returnPolicy: {
  type: "structured",
  schema: {
    success: "boolean",
    red: "number",
    orange: "number",
    yellow: "number"
  }
}
```

返回：

```
{
  "success": true,
  "red": 0,
  "orange": 3,
  "yellow": 7
}
```

适合：

* Review Agent
* Validation Agent
* Classification Agent
* Routing Agent
* Workflow Control Agent

应该优先于：

```
RED=0 ORANGE=3 YELLOW=7
```

然后再使用正则解析。

* * *

## 6.5 `summary`

允许 Agent 返回短摘要。

```
returnPolicy: {
  type: "summary",
  maxTokens: 256
}
```

适合：

* Research Agent
* Analysis Agent
* 子 Agent → 主 Agent 信息汇总

目标不是禁止返回内容，而是控制 Context 大小。

* * *

## 6.6 `discard`

业务结果已经存在于 Artifact 中，不需要 Agent Final Response。

```
returnPolicy: {
  type: "discard"
}
```

Runtime 不把 Final Response：

* 注入父 Agent Context
* 注入后续 Agent Context
* 当作 Workflow 数据
* 长期保存到普通上下文

但仍可以保留必要的运行状态：

```
{
  "success": true,
  "agent": "spec-basic"
}
```

注意：

**单纯执行完成后丢弃文本，只能减少 Context 和日志污染，不能减少已经发生的模型 Token 生成。**

因此 `discard` 仍应配合模型输出限制。

* * *

# 7. 建议 API

第一阶段可以采用：

```
agent({
  prompt: "...",

  returnPolicy: {
    type: "status-only",
    maxTokens: 32
  }
})
```

完整配置示例：

```
agent({
  agent: "spec-extractor",

  prompt: `
    分析 spec_source.md，
    输出 spec_basic.md。
  `,

  returnPolicy: {
    type: "signal",
    value: "spec-basic 已完成",
    maxTokens: 32,
    injectToParentContext: false,
    saveToLog: true
  }
})
```

* * *

# 8. Prompt 层 + Runtime 层双重约束

不能只依赖 Runtime，也不应该只依赖 Prompt。

推荐：

```
             Return Policy
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
 Prompt Constraint      Runtime Constraint
        │                     │
        ▼                     ▼
引导模型少生成          限制/过滤/验证输出
        │                     │
        └──────────┬──────────┘
                   ▼
             Workflow Return
```

## Prompt 层

Runtime 自动在 Agent Prompt 末尾注入：

```
【返回约束】

任务产出请通过规定的文件或工具完成。

最终回复必须仅用于返回执行状态。

禁止复述已经写入文件或 Artifact 的内容。
```

`signal` 模式：

```
最终回复必须严格为：

spec-basic 已完成
```

* * *

## Runtime 层

Runtime 应进一步负责：

* `maxOutputTokens`
* 返回格式校验
* Schema 校验
* Return 截断
* Context 注入控制
* 日志保存策略

最终形成：

```
Prompt = 减少模型产生垃圾输出

Runtime = 保证垃圾输出不继续传播
```

* * *

# 9. Return Validation

对于受约束的 Return，应支持 Validator。

例如：

```
returnPolicy: {
  type: "signal",
  value: "DONE",
  onViolation: "normalize"
}
```

Agent 返回：

```
任务已经完成，具体内容如下……
```

Runtime 可以处理为：

```
DONE
```

而不是继续把原始内容传播下去。

建议支持：

```
onViolation:
  | "warn"
  | "truncate"
  | "normalize"
  | "fail"
```

* * *

# 10. Context 注入控制

Return Policy 应和未来 Context Manager 集成。

例如：

```
returnPolicy: {
  type: "structured",

  injectToParentContext: true,

  injectMode: "result-only"
}
```

支持：

```
none
result-only
summary
full
```

最终做到：

```
Agent 执行结果
       ↓
Return Policy
       ↓
Context Manager
       ↓
决定哪些信息进入 Parent Agent
```

避免当前：

```
Sub Agent
    ↓
几十 KB Final Response
    ↓
全部进入 Parent Context
```

* * *

# 11. Artifact Reference

后续可以允许 Agent Return 不返回 Artifact 内容，而只返回引用。

例如：

```
{
  "success": true,
  "artifact": "spec_basic.md"
}
```

甚至：

```
{
  "success": true,
  "artifactId": "artifact://run-123/spec-basic"
}
```

父 Agent 如果真正需要内容，再主动读取。

形成：

```
Producer Agent
      ↓
Artifact Store
      ↓
返回 Artifact Ref
      ↓
Parent Agent
      ↓
需要时读取
```

这将成为 Dynamic Workflow 后续 Context Optimization 的基础能力。

* * *

# 12. Observability

每个 Agent Run 建议增加：

```
{
  "returnPolicy": "status-only",

  "returnRawTokens": 12520,
  "returnAcceptedTokens": 5,

  "returnViolation": true,

  "contextInjectedTokens": 5
}
```

后续可以统计：

```
Generated Tokens
Accepted Return Tokens
Discarded Return Tokens
Context Injected Tokens
```

从而判断哪个 Agent 存在严重 Return 泄漏。

* * *

# 13. 开发阶段规划

## Phase 1：Prompt Return Contract

目标：

把当前手写：

```
【返回约束】
...
```

升级为 Runtime 自动生成。

实现：

```
returnPolicy: {
  type: "status-only"
}
```

Runtime 自动向 Prompt 尾部追加约束。

### 验收

不再要求每个 Workflow 手写 Return Prompt。

* * *

## Phase 2：Context Filter

Runtime 控制：

```
Agent Return
    ↓
是否进入 Parent Context
```

实现：

```
injectToParentContext: false
```

### 验收

Agent 即使产生长回复，也不会污染上游 Context。

* * *

## Phase 3：Output Token Limit

支持：

```
maxOutputTokens: 32
```

从模型调用层直接限制最终输出长度。

### 验收

不能只在生成完成后截断。

目标是：

```
减少实际 Generation Token
```

而不仅是：

```
减少保存 Token
```

* * *

## Phase 4：Structured Return

实现：

```
type: "structured"
schema: ...
```

替代大量：

```
RED=...
正则解析
字符串判断
```

### 验收

Review / Validation Agent 全部可以输出结构化结果。

* * *

## Phase 5：Artifact Reference

Agent 输出大型 Artifact 后，只返回引用：

```
{
  "artifactId": "..."
}
```

Parent Agent 按需读取。

* * *

## Phase 6：Context Manager 集成

形成完整链路：

```
Agent
 ↓
Artifact
 ↓
Return Policy
 ↓
Context Policy
 ↓
Parent Agent
```

* * *

# 14. 第一版建议范围

不要一次实现完整体系。

MVP 只做：

```
returnPolicy:
  "full"
  | "status-only"
  | "structured"
```

以及：

```
maxOutputTokens
injectToParentContext
```

即：

```
agent({
  ...,

  returnPolicy: {
    type: "status-only",
    maxOutputTokens: 32,
    injectToParentContext: false
  }
})
```

这几项已经可以解决当前 Dynamic Workflow 中大部分 Return 失控问题。

* * *

# 15. 验收标准

选择当前 `spec-clarify-workflow` 作为真实测试工程。

同一 Workflow 分别运行：

```
A：无 Return Policy

B：Prompt Return Contract

C：Prompt + Runtime Return Policy
```

至少记录：

```
总耗时
总 Token
每个 Agent output token
Final Response token
Context injected token
Agent 成功率
Artifact 正确率
Review RED / ORANGE / YELLOW
```

验收目标：

1. Artifact 内容质量不下降。
2. Agent 成功率不下降。
3. Status-only Agent Final Return 控制在约定范围。
4. 大型文件内容不再重复进入 Parent Context。
5. Workflow 不依赖自然语言长回复完成控制流。
6. Return 不符合 Schema 时 Runtime 能识别。
7. Return Policy 不影响文件/Artifact 正常生成。

* * *

# 16. 最终架构定位

未来 Dynamic Workflow 的 Agent 执行模型应逐渐演变为：

```
               Dynamic Workflow Runtime
                         │
                         ▼
                      Agent
             ┌──────────┼──────────┐
             ▼          ▼          ▼
           Tools      Artifact   Internal
             │          │        Reasoning
             │          │
             └──────┬───┘
                    │
                    ▼
               Return Policy
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
      Status     Structured    Artifact Ref
        │           │            │
        └───────────┼────────────┘
                    ▼
              Context Manager
                    │
                    ▼
                Parent Agent
```

最终原则：

> **让 Agent 的业务成果进入 Artifact，让 Agent Return 只承担 Workflow 通信。**

Return Policy 不应该只是 Prompt Optimization，而应该成为 Dynamic Workflow Runtime 的标准 Agent Communication Protocol。

我建议你在 Dynamic Workflow Roadmap 里把它放在 **权限系统之后、Context Manager 之前**。因为权限系统解决的是“Agent 能做什么”，Return Policy 解决“Agent 做完以后向外暴露什么”，Context Manager 再决定“这些东西哪些进入后续上下文”。这三个模块刚好可以形成一条非常清晰的 Runtime 架构链。