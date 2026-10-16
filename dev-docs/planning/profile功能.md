能，而且我建议你把它做成 `opencode-dynamic-workflows` 的一个 **Profiler / Trace Report**，以后每次 workflow 跑完自动告诉你这 5 类问题。

你现在其实已经拿到了最关键的基础设施：Workflow 里的子 Agent `sessionId` 能从 `workflow` tool metadata 取到，再通过 OpenCode session / `opencode.db` 找到这个 Agent 的 message、tool part、时间和 Token。你之前的 FFF benchmark 已经实际走通了这条链路。

## 这 5 项分别怎么观察

| 优化项                 | 最重要的观测指标                                | 出现什么说明有问题                       |
| ------------------- | --------------------------------------- | ------------------------------- |
| ① 减少 LLM round-trip | `llmRounds`、Agent 总时间、每轮时间              | 一个简单 Agent 调模型 10~20 轮          |
| ② 减少上下文             | `inputTokens`、`cacheRead`、每轮 context 增长 | 后几轮 input 从 20k 涨到 100k+        |
| ③ 并行 Agent          | Agent start/end、Overlap、Critical Path   | 本可并行的 4 个 Agent 实际串行            |
| ④ 重复 reasoning      | `reasoningTokens`、重复 tool/query/read    | 同样文件反复 read、同 query 反复 grep     |
| ⑤ find/grep         | tool duration、调用次数、命中数                  | 总流程 300s，其中 search 只有 5s 就没必要优化 |

OpenCode 当前自己已经记录 Assistant Message 的 `created/completed`、input/output/reasoning/cache Token；Tool Part 也记录 `start/end`，所以这些指标基本都有数据源。([GitHub][1])

---

# ① 怎么观察 LLM round-trip

这个是我认为你最应该先加的。

假设 Workflow：

```js
phase("Requirement")

const result = await agent(`
分析需求
`)
```

这个 `agent()` 内部可能不是只调用了一次 LLM。

实际可能：

```text
LLM Round 1
 ↓
grep
 ↓
LLM Round 2
 ↓
read
 ↓
LLM Round 3
 ↓
read
 ↓
LLM Round 4
 ↓
grep
 ↓
LLM Round 5
 ↓
最终答案
```

用户看到：

```text
agent() × 1
```

但实际上：

```text
LLM Round-trip × 5
```

### 怎么数

最简单可以数这个 Agent session 下的：

```text
assistant message
```

更精确可以数：

```text
step-finish
```

因为 OpenCode 的 `StepFinishPart` 本身就包含：

```text
tokens.input
tokens.output
tokens.reasoning
tokens.cache.read
tokens.cache.write
cost
```

([GitHub][1])

于是你的报告直接显示：

```text
Agent: ui-requirement-agent

Duration        183.4s
LLM Rounds      12       ⚠️
Tool Calls      21

平均每轮：
15.3s
```

这马上就能看出：

> 为什么这个 Agent 要跑三分钟？

### 一个非常实用的规则

我建议先这么标：

```text
LLM rounds <= 3       🟢
4~6                   🟡
> 6                   🔴
```

当然这不是绝对标准，但特别适合找异常。

比如：

```text
ui-agent              3 rounds
code-agent             5 rounds
summary-agent         17 rounds  🔴
```

你一下就知道：

> 应该先优化 summary-agent，而不是 FFF。

---

# ② 怎么观察上下文是不是太大

这其实 OpenCode 已经记录了。

当前 Assistant Message 有：

```text
tokens:
  input
  output
  reasoning
  cache:
    read
    write
```

OpenCode 自己的 `stats` 命令也会统计这些数据。([GitHub][2])

你现在就可以先执行：

```powershell
opencode stats --project "" --models
```

看看整个项目。

但对 Dynamic Workflow 来说，更有价值的是：

## 按 Agent、按 LLM Round 展示

比如：

```text
RequirementAgent

Round     Input Context
------------------------
1          18,200
2          25,400
3          39,800
4          58,300
5          81,700
6         112,600  🔴
```

这个信息特别重要。

如果你看到：

```text
18k
25k
40k
58k
82k
112k
```

这说明 Agent 正在不停：

```text
read 文件
 ↓
结果加入上下文

grep
 ↓
结果加入上下文

read
 ↓
继续加入

tool output
 ↓
继续加入
```

最后 Context 越滚越大。

### 我建议记录两个值

不是只有：

```text
inputTokens
```

还要记录：

```text
contextTokens
=
input
+ cache.read
+ cache.write
```

OpenCode 自己的 usage 逻辑也把这些项目区分记录。([GitHub][3])

最终报告：

```text
Agent: RequirementExtractor

LLM rounds:        8
Peak Context:      126,420 tokens 🔴
Average Context:    73,210
Input Tokens:      211,402
Cache Read:        350,211
Output Tokens:      12,415
```

那么“减少上下文输入”就从一个抽象建议变成非常具体的问题。

---

# ③ 怎么知道 Agent 有没有真正并行

这个特别适合你的 Dynamic Workflow。

比如：

```js
const results = await parallel([
    () => agent("分析 UI"),
    () => agent("分析代码"),
    () => agent("分析配置"),
])
```

你期望：

```text
      ┌ Agent A ────────┐
Start ├ Agent B ────────┤ Finish
      └ Agent C ────────┘
```

但也有可能实际上：

```text
Agent A ─────────
                Agent B ─────────
                                Agent C ─────────
```

### Dynamic Runtime 最适合记录这个

在你自己的 `agent()` Runtime 外围：

```ts
const startedAt = performance.now()

const result = await executeAgent(...)

const endedAt = performance.now()
```

注意：

> 这个计时放在 Dynamic Workflow **宿主 Runtime**，不要放 workflow JS 沙箱里。

因为你的 workflow sandbox 目前明确禁止 `Date.now()` 等时间 API，这一点之前 benchmark 已经确认。

然后生成：

```text
Phase: Analyze

Agent A  0s  ├──────────────────┤ 42s

Agent B  1s   ├─────────────┤ 31s

Agent C  1s   ├───────────────────────┤ 51s
```

于是：

```text
Agent Work Sum:
42 + 30 + 50
= 122s

Phase Wall Time:
51s
```

可以计算一个非常好用的指标：

```text
Effective Concurrency
=
Agent Work Sum / Phase Wall Time

122 / 51
≈ 2.39
```

如果你明明用了：

```text
parallel(4 agents)
```

结果：

```text
Effective Concurrency = 1.1
```

那就有问题。

如果：

```text
Effective Concurrency = 3.4
```

说明并行确实发挥作用了。

---

# ④ 怎么观察“重复 reasoning”

这个不能简单理解成：

> 去读取模型内部思维内容。

没必要。

你应该观察 **行为上的重复**。

最有价值的是三个指标：

```text
Reasoning Tokens

Duplicate Tool Calls

Duplicate File Reads
```

比如报告：

```text
Agent: CodeAnalyzer

LLM rounds           14
Reasoning Tokens     31,420

Tool Calls           37
Unique Tool Calls    21
Duplicate Calls      16    🔴

read()               18
Unique Files         9
Repeated Reads        9    🔴

grep()               11
Unique Queries        6
Repeated Queries      5    🔴
```

然后再显示：

```text
重复操作：

read src/runtime.ts          ×4
read src/agent.ts            ×3

grep "createAgent"           ×3
grep "workflow"              ×2
```

这个信息比“reasoning 写了什么”有用得多。

因为你真正想优化的是：

```text
Agent：
我是不是看过这个文件？

不知道。

再 read 一次。
```

或者：

```text
Round 2
grep workflow

Round 5
grep workflow

Round 8
grep workflow
```

这就是实打实的浪费。

### reasoningTokens 只是辅助指标

例如：

```text
Agent A
reasoning = 4k

Agent B
reasoning = 48k 🔴
```

你可以进一步调查 B。

但不要仅仅看到 reasoning 高就判断它有问题。

复杂任务本来就可能需要更多 reasoning。

---

# ⑤ 怎么观察 find / grep 是否值得优化

你现在 FFF Benchmark 已经做到了这一点。

Tool Part 里面有：

```text
time.start
time.end
```

所以：

```text
toolDuration
=
end - start
```

([GitHub][1])

例如：

```text
Workflow Total       300s

LLM                  242s
read                   21s
grep                   14s
glob                    7s
write                   5s
other                  11s
```

一眼就知道：

```text
LLM       80.7%
Search     7.0%
```

这和你这次 FFF Benchmark 的实际发现完全一致：当时纯搜索约占 explore Agent 的 19.3%，LLM 占约 80.7%。

所以：

```text
优化 grep 50%
```

可能只让：

```text
300s
→
290s
```

而：

```text
减少 3 次 LLM round
```

可能直接：

```text
300s
→
220s
```

优化优先级就非常清楚了。

---

# 我建议你给 Dynamic Workflow 加一个 Profile Report

以后每个 Workflow 结束直接生成：

```text
Workflow Profile
────────────────────────────────────

Total Duration
324.2s

Agents
3

LLM Rounds
21 🔴

Tokens
Input             312k
Reasoning          48k
Output             22k
Cache Read        420k

────────────────────────────────────

Time Breakdown

LLM                251.4s   77.5%
Tool                 54.2s   16.7%
Other                18.6s    5.8%

Tool Breakdown

read                 22.4s
grep                 13.1s
glob                  7.2s
write                 5.1s
bash                   6.4s

────────────────────────────────────

Agent

RequirementAgent

Duration             142s
LLM Rounds             11 🔴
Peak Context          98k 🔴
Reasoning Tokens      31k
Tool Calls             24
Duplicate Calls         8 🔴

────────────────────────────────────

Parallel

Analyze Phase

Agents                  3
Work Sum              126s
Wall Time              52s
Effective Parallelism  2.42x

────────────────────────────────────

Warnings

🔴 RequirementAgent has 11 LLM rounds
🔴 Context grows from 21k → 98k
🟡 src/runtime.ts read 4 times
🟡 grep "workflow" executed 3 times
🟢 Search only accounts for 6.3% of total time
```

这样以后你再碰到：

> “这个 Agent 为什么跑了 8 分钟？”

不需要猜。

直接看：

```text
8分钟
 ↓
是 LLM rounds 太多？

Context 爆炸？

Agent 没并行？

重复 read/grep？

还是 tool 本身真的慢？
```

---

## 你甚至不用修改 OpenCode

我建议架构做成：

```text
                 OpenCode
                    │
       ┌────────────┴────────────┐
       │                         │
  Main Session              Child Sessions
                               │
                    agent A / B / C
                               │
                       messages / parts
                               │
               ┌───────────────┴──────────────┐
               │                              │
             Tokens                       Tool Time
               │                              │
               └───────────────┬──────────────┘
                               ↓
                  Dynamic Workflow Profiler
                               ↓
                     workflow-profile.json
                               ↓
                       Profile Report
```

你现在 OpenCode 原生也有 `opencode stats` 和 `opencode export <sessionID>`，所以第一版甚至可以完全做成**离线分析器**，不动 OpenCode Core。([OpenCode][4])

而你的 Dynamic Workflow 已经掌握了：

```text
Workflow
→ agent()
→ child sessionId
```

这正是做 profiler 最关键的映射关系。你之前的 benchmark 已经通过 `workflow` tool metadata 找到子会话 ID，再从 `opencode.db` 提取 tool parts，所以技术路线已经验证过了。

**如果让我给你现在的 `opencode-dynamic-workflows` 排优先级，我会把这个 Profiler 提到很高。** 因为有了它之后，你再优化 Agent，不再需要凭感觉判断“是不是上下文太大”“是不是 search 太慢”，而是每次修改前后都能直接做 A/B。

[1]: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts?utm_source=chatgpt.com "opencode/packages/sdk/js/src/gen/types.gen.ts at dev · anomalyco/opencode · GitHub"
[2]: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/stats.ts?utm_source=chatgpt.com "opencode/packages/opencode/src/cli/cmd/stats.ts at dev · anomalyco/opencode · GitHub"
[3]: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/usage.ts?utm_source=chatgpt.com "opencode/packages/opencode/src/acp/usage.ts at dev · anomalyco/opencode · GitHub"
[4]: https://opencode.ai/v2/docs/cli/commands/?utm_source=chatgpt.com "Commands | OpenCode"
