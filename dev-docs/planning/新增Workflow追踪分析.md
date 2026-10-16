**ChatGPT:**

我先读取仓库当前的执行器、子 Workflow 调用方式，以及已有的 trace、journal 和 resume 机制，再评估怎么加 `development` 模式，尽量复用现有能力，不另造一套执行记录系统。重点会放在完整保留父子执行轨迹，以及把轨迹转化为可验证的优化建议。

* * *

**ChatGPT:**

从代码里已经确认：仓库有可复用的基础，包括按 `runId` 保存的 journal、每次 Agent attempt 的执行记录，以及原生子 Workflow 的 `scopePath`。但这些目前主要服务于恢复执行和 TUI 展示，还不是你想要的“完整执行历史”。

还有一个关键区别：原生 `workflow()` 子流程共享父 Run，而 Agent 在子会话里再次调用 `workflow` 工具，会创建独立 Run。这两条链路需要不同的 trace 归集方式。

* * *

**ChatGPT:**

采集路径也基本确定了：OpenCode SDK 提供 `session.messages()`，可以读取 Agent Session 的消息与工具执行记录；插件层还有工具执行 Hook，适合补充实时事件。

OpenCode

GitHub

我倾向于第一版先做“运行结束后按 Session 归档 + 执行中增量记录关键事件”，避免一上来就为每个模型消息设计复杂的实时监听系统。下面我会把落盘结构、分析规则和开发优先级收敛为可执行方案。

* * *

**ChatGPT:**

# OpenCode Dynamic Workflows：Development Trace & History 功能设计评审

我查看了你仓库当前 `main` 分支的实现，版本为 v0.11.2，重点阅读了 Runtime、Journal、OpenCode Session Adapter、子 Workflow、后台执行和已有的 `workflow-optimize` Skill。

结论：这个功能很值得做，而且适合直接扩展现有架构，不需要重新开发一套 Workflow 执行系统。

但我建议把你的想法提升为一个完整的功能：

Workflow Development Mode（工作流开发诊断模式）

它不仅记录 Trace，还可以构成一个持续优化 Workflow JS 脚本的闭环：

Workflow 执行（包含全部子 Workflow）

development: true

Trace Collector

采集 Agent 对话、工具调用、脚本、结果、错误与耗时

Unified Execution History

父子关系 + 全局时间线 + 原始证据

Workflow Analyzer

发现可固化脚本、重复操作、不必要的 Agent 调用和失败模式

Optimization Proposals

生成优化建议和代码候选 → 验证 → 人工批准 → 应用

这里最重要的架构原则是：

Trace 是事实，History 是整理后的执行档案，Analysis 是推论，Optimization 才是代码修改。

把四层分开，可以保证以后扩展更多优化策略，而不是一开始就把所有逻辑绑在 LLM 分析上。

## 一、当前仓库已经具备哪些基础？

|   现有模块   |   实际能力   |   新功能所需改造   |
| --- | --- | --- |
|   `JournalStore`   |   保存成功调用结果及部分失败 attempt   |   保留原用途，不作为完整 Trace   |
|   `WorkflowExecutionRecord`   |   记录父子 Workflow 的身份、状态、耗时   |   增加完整执行事件   |
|   `AgentExecutionRecord`   |   保存重试、会话 ID、错误、用量   |   关联 Session Trace   |
|   `OpenCodeSessionAdapter`   |   创建独立 Agent Session 并取得结果   |   增加 Session 内容采集   |
|   `run-lineage.ts`   |   关联嵌套执行的根 Session   |   增加根 Run 与子 Run 的关系   |
|   `workflow-optimize` Skill   |   优化脚本、版本备份、执行质量比较   |   直接消费分析结果，形成优化闭环   |

相关源代码：[Runtime](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/src/runtime/workflow-runtime.ts)、[Journal](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/src/persistence/journal.ts)、[Adapter](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/src/adapters/opencode-session-adapter.ts)。

有三个关键发现：

1. 现有 Journal 不等于完整 Trace。

当前成功 Agent 的 journal 主要保存结果、截断的原始 prompt 和执行元数据，失败记录主要保存 attempt 信息。它没有完整保留 Agent 运行过程中执行的全部工具调用及其输入输出，因此无法可靠分析“这个 Agent 实际编写了什么临时脚本”。

2. 原生子 Workflow 的执行身份已经基本解决。

目前通过 `scopePath`，例如 `["root", "wf0", "wf2"]`，可以区分不同层级和实例。原生子 Workflow 共享父 Run，适合统一归档。

3. 仓库已经有 `workflow-optimize` Skill。

这个 Skill 具备版本备份、执行、产物快照、质量评审、经验回填的能力。

所以我不建议重新实现优化器，而是让新的 Trace Analyzer 为现有 `workflow-optimize` 提供真实执行证据，补上目前缺少的自动诊断能力。

## 二、推荐的实现架构

我建议拆成 5 个模块，而不是在 `JournalStore` 中直接追加逻辑。

[Image]推荐的模块边界：Runtime 只负责执行与发射事件；采集、存储、合并、分析互不侵入。

### 2.1 Trace Collector：怎么记录完整执行过程？

建议采用双通道采集。

|   采集方式   |   记录内容   |   作用   |
| --- | --- | --- |
|   Runtime Event   |   Workflow、Agent、Composite 的开始、结束、状态、重试、恢复   |   准确还原执行树   |
|   OpenCode Session   |   模型消息、工具调用、命令、输入输出、错误   |   还原 Agent 内部实际做了什么   |

OpenCode SDK 的 `session.messages()` 可以获取某个 Session 中的消息及 Parts，包括可访问的工具执行数据。

OpenCode

例如 Agent 的实际执行过程可能是：

```
Agent: 生成 UI 配置
  ├── read(config.json)
  ├── grep("button")
  ├── bash("python generate_ui.py")
  ├── write("fix_config.py")
  ├── bash("python fix_config.py")
  ├── bash("python fix_config.py")
  └── 最终结果：完成
```

当前 Journal 主要会保留最终结果和执行元数据。

新的 Trace 则需要保留各次工具调用、工具参数、实际返回值以及它们发生的顺序。

这样才能在事后判断：`fix_config.py` 是一次性修复，还是值得抽取为 Workflow 的固定步骤。

**实现位置：**优先在 `OpenCodeSessionAdapter` 扩展 Session Trace 采集接口，再让 `TraceCollector` 负责保存，不让 Runtime 直接依赖 OpenCode SDK。

第一版可以在 Agent 结束时调用 `session.messages()`，并在执行期间增量落盘 Runtime 事件。后续再用工具 Hook 增强实时捕获能力。

这里有一个边界：OpenCode 返回的数据不一定包含所有临时文件的最终内容，尤其是创建后又删除的脚本。因此需要保留 `write/edit/bash` 等工具的实际输入证据；无法捕获时明确标记缺失，而不是声称 Trace 完整。

### 2.2 Trace Store：如何保存？

不要覆盖现有 Journal，建议采用单独的目录：

```
.opencode-workflows/
├── workflows/
├── journal/                  # 原有 resume 数据
├── runs/                     # 原有 TUI 状态快照
└── history/
    └── run-abc123/
        ├── manifest.json
        ├── traces/
        │   ├── root.jsonl
        │   ├── wf0.jsonl
        │   └── wf1.jsonl
        ├── sessions/
        │   ├── ses-a.json
        │   └── ses-b.json
        ├── history.jsonl
        ├── history.md
        └── analysis/
            ├── report.md
            └── proposals.json
```

其中 `traces/` 和 `sessions/` 是原始证据，原则上写入后不修改；`history.jsonl` 是合并后的机器可读时间线；`history.md` 是方便人和 LLM 阅读的整理视图。

不能只保留 Markdown，因为 Markdown 丢失结构之后，后续想做工具调用统计、脚本提取、跨 Run 分析就会很麻烦。

### 2.3 父子 Workflow 如何合并？

这里需要特别考虑你已有的两种嵌套方式。

原生调用 `workflow('./child.js')`： 使用当前的 `runId + scopePath` 就能够确定父子关系。合并工作比较直接。

Agent 在子 Session 中再次调用 `workflow` 工具： 这是独立 Run。当前 `run-lineage.ts` 只记录子 Session 到根 Session 的对应关系，并没有建立完整、持久化的 Run-to-Run 父子链。

我建议新增以下关联字段：

JSON

```
{
  "rootRunId": "run-001",
  "runId": "run-003",
  "parentRunId": "run-001",
  "parentExecutionId": "run-001:2:1",
  "scopePath": ["root"],
  "sessionId": "ses-child"
}
```

合并过程必须支持并行，不能简单地把子 Workflow 的日志接在父 Workflow 后面。

应该同时产生：

* 执行树：谁调用谁，哪个 Agent 属于哪个 Workflow。
* 全局时间线：按时间排列的真实事件，允许多个 Agent 执行时间交叠。

还有一个容易忽略的点：当前 `resumeFromRunId` 会复用原来的 `runId`。因此建议再增加 `runAttemptId`，区分第一次执行和每一次恢复执行，避免不同恢复轮次的事件 ID 碰撞或者覆盖历史。

## 三、History Analyzer：如何发现真正值得优化的地方？

这是这套设计的核心价值。

我建议第一版先支持四类分析，全部要求能够追溯到具体 Trace，而不是由 LLM 凭印象判断。

A. 临时脚本固化（优先级最高）

检测 Agent 使用 Python、Node、Shell 等编写并执行脚本的行为，识别可参数化、确定性、重复使用的代码，把它们提议为 `scripts/*.py` 或 `.mjs` 等固定工具。

B. 重复执行识别

检测相同文件的反复读取、重复搜索、多个 Agent 重复完成相同工作，以及可以合并的工具调用。区分必要重试和无效重复。

C. 失败与异常模式

发现命令反复失败、错误恢复路径过长、检查节点过晚、错误被吞掉、同类异常反复出现等问题。重点判断能不能通过固定校验或调整控制流解决。

D. Workflow 架构优化

判断任务是否适合拆成子 Workflow、某些 Agent 是否其实只需要确定性 `check()`、并行执行是否存在重复劳动或资源竞争。

### 实际分析示例

假设某个 Workflow 运行后有这样的 Trace：

```
Phase 1: 读取策划文档
  Agent A:
    读取 15 个 Markdown
    编写 extract_images.py
    运行 extract_images.py
    结果成功

Phase 2: 提取需求点
  Agent B:
    读取 15 个 Markdown
    编写 normalize_ids.py
    运行 normalize_ids.py
    结果成功

Phase 3: 质量检查
  Agent C:
    编写 validate_ids.py
    运行时报错
    修改 validate_ids.py
    重跑成功
```

Analyzer 可以提出这样的优化建议：

建议：把编号校验固化为确定性脚本

待验证

类型：SCRIPT_EXTRACTION · 来源：Phase 3 / Agent C

发现的问题

Agent 在执行过程中临时生成了编号校验逻辑，首次执行失败，随后修改脚本成功。该步骤可能具有确定性，不一定需要 LLM 每次重新编写。

建议修改

将已经验证的校验逻辑提取到 `scripts/validate-ids.mjs`，由 Workflow 调用固定脚本。

验证要求

需要提供真实的脚本内容、输入输出样本、失败边界和回归测试；通过后才能接受该建议。

证据：工具调用 / 脚本内容 / 错误输出

建议阶段

特别注意：不能因为 Agent 编写过一次脚本，就认定应该固化。

一个脚本是否适合固化，至少要判断输入输出是否稳定、业务规则是否确定、是否依赖模型推理，以及是否能够在真实样本上通过回归测试。

我甚至建议把“发现潜在固化机会”和“批准固化”拆成两个阶段，避免把临时补丁变成永久技术债。

## 四、Development 选项怎么设计？

这里我建议将 Trace Capture 和 Development Analysis 解耦。

例如：

JavaScript

```
workflow({
  scriptPath: "./feature-development.js",
  development: true
})
```

上面表示开启完整采集、结束后构建 History，并生成分析报告。

但从长期产品设计看，建议额外预留 `trace` 配置，而不是让 `development=false` 意味着完全丢弃执行数据。

|   配置   |   Trace   |   自动合并 History   |   优化分析   |
| --- | --- | --- | --- |
|   默认运行   |   保留轻量记录   |   否   |   否   |
|   `trace: "full"`   |   完整记录   |   可手动触发   |   可手动触发   |
|   `development: true`   |   完整记录   |   是   |   是   |

如果你希望项目里的每一次 Workflow 都保存完整 Trace，可以在项目级配置中启用 `trace: "full"`；不建议对所有插件使用者默认开启无限制的完整 Session 归档，因为其中可能包含敏感内容和大量工具输出。

原生子 Workflow 应自动继承根 Run 的采集策略，无需分别打开 Development。

分析结束后的报告默认只提出建议，不自动修改 Workflow JS，也不自动执行提取出的脚本。

## 五、结合仓库现状，我建议的开发优先级

|   阶段   |   开发范围   |   验收标准   |
| --- | --- | --- |
|   P0   |   Trace Collector、Trace Store、父子关联   |   成功/失败/中断均能保留完整可采集证据   |
|   P1   |   History Builder、`development` 参数   |   完整生成父子执行树及时间线   |
|   P2   |   Analyzer + 四类规则   |   可以通过真实工具调用证据识别优化机会   |
|   P3   |   优化建议生成、脚本提取验证、Skill 集成   |   能将建议转换成可测试、可人工批准的改动   |

### P0 有几个必须提前解决的问题

第一个是 `runWorkflow()` 出错时会直接抛异常，无法保证调用方拿到完整的 `WorkflowRunResult`。建议增加 `onWorkflowUpdate`，并确保失败、中断时也完成 Trace 归档。

第二个是当前 `JournalStore.recordExecution()` 最多保留最近 10 条 execution，而且 Journal 本身面向 Resume，会更新已有键。不能直接复用这个格式来保存不可变的完整 History。

第三个是 `CompositeRecord.id` 在每个 scope 内从 `cmp0` 开始，当前部分进度收集代码按 `id` 查找替换。History 系统要使用复合身份，例如 `runId + scopePath + compositePath`，否则不同子 Workflow 的组合节点可能冲突。

第四个是所有落盘都需要处理截断、脱敏、保留周期和写盘失败。最好在 `manifest.json` 里记录 `complete / partial / failed` 等采集完整性状态。没有证据的执行过程不能推断成已经完整采集。

### 建议新增的代码组织

```
src/
├── trace/
│   ├── collector.ts
│   ├── store.ts
│   ├── events.ts
│   └── sanitizer.ts
├── history/
│   ├── builder.ts
│   ├── lineage.ts
│   └── schema.ts
├── analysis/
│   ├── analyzer.ts
│   ├── rules/
│   │   ├── script-extraction.ts
│   │   ├── duplicate-work.ts
│   │   ├── failure-pattern.ts
│   │   └── workflow-structure.ts
│   └── report.ts
```

新增的模块尽量独立于 OpenCode SDK，将来如果你的 Workflow Runtime 还要支持 Pi Agent 或其他 Harness，只需要由不同 Adapter 提供统一的 Trace Event 即可。

### 六、如何与现有 `workflow-optimize` Skill 配合？

你目前的 [workflow-optimize Skill](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-optimize/SKILL.md) 已经在做优化迭代闭环。

两者不应该重复：

|   模块   |   职责   |
| --- | --- |
|   Trace Collector   |   记录实际发生了什么   |
|   History Analyzer   |   找到潜在问题和优化机会   |
|   workflow-optimize Skill   |   根据建议改版、验证效果、产出报告、沉淀经验   |

推荐的最终闭环：

Mermaid 图表

运行 Workflow

采集完整 Trace

合并 History

自动诊断

生成 Optimization Proposals

workflow-optimize Skill

修改候选 Workflow

真实运行与回归验证

验证通过？

保留旧版与失败证据

人工确认应用

沉淀优化经验

否

是

这能让开发模式逐步具备跨运行的经验积累能力，但第一阶段不需要引入向量数据库、长期记忆系统或自动进化 Agent。

## 七、需要优先测试的五个场景

|   测试   |   必须证明   |
| --- | --- |
|   原生 3 层子 Workflow   |   所有 Agent Trace 都能按正确层级合并   |
|   Agent 内再次调用 Workflow 工具   |   独立子 Run 能正确归属于根 Run   |
|   并行执行 + Retry + Resume   |   时间线无漏记、身份不冲突、历史不被覆盖   |
|   Agent 执行中编写并运行脚本   |   能还原可访问的代码和工具输入输出，缺失证据有标记   |
|   失败、中止或插件重启   |   已写入 Trace 不丢，能生成部分 History   |

我的最终建议是先完成 P0 + P1，使用一条包含多级子 Workflow、并行 Agent、脚本生成和故意失败重试的真实工作流来验收。

此时先不接 LLM Analyzer，直接查看 `history.jsonl` 是否能够真实还原整个过程。只有这一步可靠，后面的“自动发现可固化脚本”和“优化 Workflow”才有可信的基础。

第一版最关键的产品目标不是自动修改代码，而是：

给定一个 `runId`，能够还原这个 Workflow 及其全部子 Workflow 实际做过什么，保留可核查的执行证据，并从中生成可以验证的优化建议。

* * *

**You:**

还有一个需求就是 开启了development后，每次一次workflow执行完成后，自动会后面读取history然后优化的流程，这一步怎么出发

* * *

**ChatGPT:**

你的这个需求，建议通过 Workflow Runtime 的执行完成事件，自动触发一个独立的 Development Optimization Job（开发优化任务）。

不需要让 Main Agent 再发起一次调用，也不需要在每个 Workflow JS 末尾手动编写优化代码。 由插件自动接管后续流程。

## 一、推荐的触发流程

Mermaid 图表

启动 Workflowdevelopment: true

执行主 Workflow

执行全部子 Workflow

主 Workflow 结束

Trace 收尾及持久化

History Builder合并完整 History

History 已归档？

记录归档失败或部分缺失

触发 Development Job

确定性规则分析

启动 Optimizer Agent

读取分析结果及必要 Trace

生成优化建议与代码候选

运行验证并生成优化报告

等待人工审核应用

否

是

整个过程分成两个生命周期：

* Execution Lifecycle：执行 Workflow、收集 Trace、构建 History。
* Development Lifecycle：读取 History、分析、生成优化方案、验证。

两者相互独立。原 Workflow 执行完就可以正常返回，不用等待优化任务结束。

## 二、具体怎么触发？

我推荐采用 `Post-Run Hook + 持久化任务队列`，而不是让 Agent 自己判断什么时候优化。

### 1. 用户正常开启 Development

JavaScript

```
workflow({
  scriptPath: "./feature-development.js",
  development: true
})
```

无需修改 `feature-development.js` 本身。

### 2. 在 Runtime 完成时产生事件

可以设计一个统一的完成事件：

TypeScript

```
interface WorkflowFinishedEvent {
  runId: string
  runAttemptId: string
  rootRunId: string
  status: "completed" | "failed" | "aborted"
  development: boolean
}
```

当根 Workflow 结束后，进入统一的 `RunFinalizer`。

这里需要注意：不是一收到 `run.completed` 就立即启动优化，而是等 Trace 归档完成、History 构建完成后再触发。

因此我建议真正的触发事件叫：

`history.ready`

### 3. 自动创建优化任务

核心伪代码：

TypeScript

```
async function onHistoryReady(event: HistoryReadyEvent) {
  if (!event.development) return
  if (!event.isRootRun) return
  if (event.trigger === "development-optimizer") return

  await developmentJobs.createOnce({
    id: `${event.runAttemptId}:optimize`,
    sourceRunId: event.runId,
    historyPath: event.historyPath,
    status: "pending"
  })

  developmentQueue.wake()
}
```

关键点是 `createOnce`：同一次执行只创建一项优化任务，即使插件重复收到完成事件，也不会重复分析。

### 4. 优化任务怎么执行？

这里有两种方案：

|   方案   |   实现   |   我的评价   |
| --- | --- | --- |
|   A. 插件直接启动一个 Optimizer Agent   |   使用现有 OpenCode Adapter 创建独立 Session   |   简单、适合 MVP   |
|   B. 插件自动执行一个内部 Optimization Workflow   |   复用 `runWorkflow()`，支持多个 Agent、规则分析、验证节点   |   推荐长期采用   |

我更推荐 B 方案，因为你已经开发了自己的 Workflow 引擎，完全可以用它优化其他 Workflow。

例如插件内部有一个专用的：

`development-optimizer.js`

其逻辑类似：

JavaScript

```
export const meta = {
  name: "development-optimizer"
}

phase("分析执行历史")

const findings = await agent(
  `分析 History：${args.historyPath}，
   找出重复工具调用、临时脚本、
   失败模式与可固化步骤`,
  { agentType: "general" }
)

phase("生成优化方案")

const proposal = await agent(
  `根据分析结果生成 Workflow 优化建议，
   必须绑定执行证据：
   ${JSON.stringify(findings)}`,
  { agentType: "general" }
)

return proposal
```

正式实现时，应先用确定性分析器筛选事件，再把必要证据交给 Agent，而不是每次把完整 History 塞进模型上下文。

## 三、如何防止自动优化无限循环？

这是实现中最重要的控制规则之一。

假设：

```
业务 Workflow 完成
    ↓
Development Optimizer 自动执行
    ↓
Optimizer 也是 Workflow
    ↓
Optimizer 执行完成
    ↓
再次触发 Optimizer？
```

如果不处理，就会无限递归。

建议设置三个限制：

1. 只有根业务 Workflow 可以启动 Development Job，普通子 Workflow 不单独触发。
2. Optimizer 自身的 `development` 强制为 `false`，并标记 `trigger: "development-optimizer"`。
3. Optimizer 验证候选脚本所执行的 Workflow，同样禁止自动触发新的优化任务。

对于 Agent 在子 Session 内独立启动的 Workflow，还需要你前面提到的 `parentRunId` 关系，将它们全部归集完成，再触发根 Run 的分析任务。

## 四、你的现有仓库具体需要改哪里？

|   文件   |   改动   |
| --- | --- |
|   `src/tools/workflow.ts`   |   新增 `development` 参数，前台完成时调用统一 Finalizer   |
|   `src/tools/background-runs.ts`   |   后台完成、失败、中止时也调用 Finalizer   |
|   `src/runtime/workflow-runtime.ts`   |   补充 Root Run 事件与执行身份   |
|   `src/trace/`   |   新增 Trace 收集与持久化   |
|   `src/history/`   |   构建 History，产生 `history.ready`   |
|   `src/development/manager.ts`   |   自动创建、调度、恢复优化任务   |
|   `src/development/optimizer.ts`   |   执行分析与优化 Workflow   |

尤其注意，当前前台 Workflow 和后台 Workflow 是两条执行路径，不建议在两边各写一套优化触发逻辑。

应该统一到 `RunFinalizer`，保证触发条件和执行次数一致。

另外，任务队列应该持久化到磁盘。插件进程关闭后无法继续执行内部优化任务，但重新启动 OpenCode 时可以扫描未完成任务并恢复。

## 五、我建议 Development 采用三个等级

Development 自动化级别

[ ]

Analyze — 自动读取 History，生成分析报告

[x]

Propose — 自动分析并生成优化代码候选及验证结果

[ ]

Apply — 验证通过且获得人工批准后应用优化

对应配置

development: { mode: "propose" }

复制

推荐默认模式：生成可审查的候选改动，不直接修改业务 Workflow。

我的建议是把 `development: true` 定义为 `mode: "propose"`。

也就是说，每次业务 Workflow 结束，插件自动完成：

History 归档 → 分析 → 生成优化候选 → 验证 → 输出报告。

用户只负责最后决定是否接受优化。

这样你的 Dynamic Workflows 就不只是一个执行引擎，而是开始具有基于实际运行证据持续改进 Workflow 的能力。

还有一条非常重要的设计原则：优化 Job 的失败绝不能把已经成功的业务 Workflow 改成失败状态。 两者必须分别保存状态、错误和执行历史。

* * *

**You:**

可以，我应该怎么开始

* * *

**ChatGPT:**

我建议你先做一个最小闭环（MVP），不要一开始就实现完整的自动优化系统。

第一阶段的目标非常明确：

> 开启 `development: true` → 执行 Workflow（包含子 Workflow）→ 保存完整 Trace → 自动合并 History → 自动启动分析 Agent → 输出优化报告。

先不自动修改原 Workflow JS。等这条链路真实跑通，再增加脚本固化、优化代码生成和自动验证。

结合你当前 `opencode-dynamicworkflows` 的 v0.11.2 架构，我建议按下面的顺序开始。

## 一、开发顺序

第一阶段

打通最小闭环

1. P0：验证 Trace 采集能力
    
    确认 OpenCode SDK 能读取 Agent Session 的完整工具调用，包括 bash 命令、write/edit、输入输出和错误。
2. P1：保存 Trace，合并 History
    
    支持父子 Workflow、并行 Agent、Retry 和 Resume，形成一个可追溯的 History。
3. P2：自动触发分析
    
    增加 `development` 开关，执行结束后通过 `history.ready` 自动启动独立的优化任务。
4. P3：实现第一个分析规则
    
    检测 Agent 临时生成、执行的脚本，判断哪些可能固化为可复用工具。

## 二、第一步具体做什么？

先创建开发分支：

Bash

```
git checkout main
git pull
git checkout -b feat/development-history

npm install
npm run typecheck
npm test
```

然后先做一个小型技术验证，而不是立即重构 Runtime。

### P0：验证 OpenCode Session Trace

重点检查：

`src/adapters/opencode-session-adapter.ts`

在测试环境中创建一个 Agent Session，让它执行：

```
读取 package.json
创建一个临时 JavaScript 脚本
运行这个脚本
修改脚本
再次执行
删除临时脚本
```

然后调用 OpenCode SDK 的 `session.messages()`，验证是否能获取实际工具执行记录。

必须回答三个问题：

|   验证项   |   要求   |
| --- | --- |
|   工具调用记录   |   能取得工具名称、参数、执行结果   |
|   临时脚本   |   能从工具输入或其他证据还原脚本内容   |
|   异常执行   |   Agent 失败或中止时，能保留已产生的记录   |

只有 P0 通过，才进入 History 开发。

因为如果拿不到 Agent 内部实际写过的脚本，后续的“自动固化脚本”分析就缺少核心证据。

## 三、第二步：实现最小 History

第一版先只完成三个文件：

```
src/
├── trace/
│   ├── collector.ts
│   └── store.ts
└── history/
    └── builder.ts
```

每个 Run 保存：

```
.opencode-workflows/history/
└── run-abc123/
    ├── manifest.json
    ├── trace.jsonl
    ├── history.jsonl
    └── history.md
```

这里有一个必须修正的设计：原生子 Workflow 可以直接用 `scopePath` 关联；Agent 在子 Session 内再次调用 `workflow` 工具则会创建独立 Run，需要补充 `parentRunId` 和 `rootRunId`。

另外，`Resume` 必须使用独立的 `runAttemptId`，避免覆盖上一次执行的历史。

P1 的验收不是文件成功生成，而是 History 能准确还原父子执行顺序、工具调用和错误。

## 四、第三步：自动触发 Development Job

这一阶段才引入：

```
src/development/
├── manager.ts
├── job-store.ts
└── optimizer.ts
```

修改两处现有入口：

* `src/tools/workflow.ts`：前台执行。
* `src/tools/background-runs.ts`：后台执行。

统一通过 `RunFinalizer` 处理，确保正常完成、失败和中止均能归档 History。

当 `history.ready` 触发后，自动创建一个持久化的 Development Job。

TypeScript

```
async function onHistoryReady(event: HistoryReadyEvent) {
  if (!event.development) return
  if (!event.isRootRun) return
  if (event.isOptimizerRun) return

  await developmentManager.enqueueOnce({
    jobId: `${event.runAttemptId}:optimize`,
    runId: event.runId,
    historyPath: event.historyPath,
  })
}
```

这个 Optimization Job 使用你现有的 `runWorkflow()` 执行能力，复用 OpenCode Agent，不需要另建 AI 调用体系。

第一版只做分析，不修改原脚本。

## 五、第四步：验证真正的业务价值

我建议选一个真实场景：

让 Agent 在 Workflow 内临时编写并执行 Python 或 JavaScript 脚本。

执行完成后，Analyzer 应该能生成类似报告：

```
Workflow: feature-development
Run: run-abc123

检测结果：

1. 发现 4 次临时脚本创建
2. 其中 2 次执行失败后进行了修复
3. 发现 1 个潜在可固化脚本
4. 建议提取为 scripts/normalize-config.mjs

证据：
- Agent Session ID
- Tool Call ID
- 原始命令
- 脚本内容
- 执行结果

优化状态：待验证
```

报告中的数字必须来自真实 Trace，而不是 Agent 推测。

## 六、可以直接交给 OpenCode 的第一条开发任务

下面这段可以直接复制到 OpenCode，让它先完成 P0 调研与实验。

P0 开发任务提示词

复制提示词

先要求 Agent 做真实测试、输出证据，不要直接开始完整功能开发。

## 七、我建议暂时锁定的技术决策

|   决策项   |   建议   |
| --- | --- |
|   功能入口   |   Workflow 工具参数 `development: true`   |
|   子 Workflow   |   默认继承根 Run 的 Development 模式   |
|   数据格式   |   JSONL 原始事件 + Markdown 阅读视图   |
|   触发机制   |   `history.ready` + 持久化任务队列   |
|   优化执行   |   复用现有 `runWorkflow()`   |
|   首个分析能力   |   临时脚本固化机会识别   |
|   自动改写原 Workflow   |   第一版禁止   |
|   防止无限触发   |   Optimizer Run 强制关闭 Development   |
|   隐私与容量   |   本地存储、脱敏、容量限制、Git 忽略   |

注意 `development` 是新增的 Workflow 工具执行参数，不是现有 DSL `workflow()` 原语的参数。原生子 Workflow 通过运行上下文继承，不需要逐个配置。

### 我建议你现在就从 P0 开始

因为整个方案中最大的不确定性，不是怎么调用 Analyzer，而是：

能否完整地获取 Agent 内部执行工具的真实过程，尤其是动态生成和执行过的脚本。

这一步验证成功，后面的 History Builder、自动触发 Development Job 和 Optimizer Agent，基本都可以建立在你现有的执行架构之上。

等 P0 的真实测试报告出来，再确定 P1 的具体接口和数据结构，能够减少大量返工。