# 进阶用法：模型编排、schema 结构化、超时重试、参数注入、后台运行、断点续跑、质量 DSL、worktree 隔离

[English](../how-to-guides.md) | **简体中文**

> 六个独立场景，按需取用。DSL 全部参数与语义的权威细节见 [workflow-authoring DSL 参考](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)。

## 使用不同模型编排（model / tier）

**场景**：不同子任务难度不同——分类、摘要、格式转换用便宜模型，核心生成（DSL、代码、评审）用强模型，省钱又保质量。

```javascript
// 方式一：显式指定模型，必须是 "provider/modelId" 完整格式
const outline = await agent('生成大纲', { model: 'openai/gpt-4o-mini' })

// 方式二：先配 model-tiers.json，脚本里只写层级名（推荐，换模型不改脚本）
const draft = await agent('写正文', { tier: 'big' })
```

tier 配置文件（JSON）——全局 `~/.config/opencode/workflows/model-tiers.json`，项目 `.opencode-workflows/model-tiers.json`（同名键覆盖全局）：

```json
{
  "tiers": {
    "small": "openai/gpt-4o-mini",
    "big": "anthropic/claude-sonnet-4-6"
  }
}
```

要点：

- `model` 必须带 provider 前缀，裸 `modelId` 会直接报错 `agent model 必须是 provider/modelId 格式`
- 优先级：显式 `model` > `tier` > 会话默认模型
- tier 名自定义（small/medium/big 只是惯用名）；未配置的 tier 回退会话默认模型并打一条告警（不中断）
- 分工经验：大量廉价杂活（分类/摘要/格式检查）用小模型，少量关键生成用强模型；两者都用 schema 约束返回时互不影响

## schema 结构化返回

**场景**：编排代码要按字段消费结果（`if (result.ok)`、`result.files`），不要模型自由发挥后再自己 `JSON.parse`。

```javascript
const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'summary'],
}

const result = await agent('分析这个模块的风险', { schema: SCHEMA })
if (!result.ok) return '分析失败：' + (result.summary ?? '')
```

要点：

- 返回值形态：带 `schema` 返回 JSON 对象（字段直接访问），不带返回 string——同一脚本混用两种调用时注意判型
- `required` 填编排真正依赖的字段；输出经服务端校验，缺失必填字段视为失败，进入与普通 agent 相同的 retry/failed 流程
- 实现机制：走 OpenCode 原生结构化输出（`format: json_schema`）；网关不支持时自动降级（prompt 要求 JSON + 本地宽松解析 + 必填校验），脚本无需感知
- 已知现象：schema agent 的子会话正文可能为空（结果在 StructuredOutput 工具调用里，不在正文）——正常，不是故障，见 [troubleshooting](troubleshooting.md)
- 与质量 DSL 组合：输出格式不稳定时 `retry(() => agent(prompt, { schema }), { until: r => r && r.ok })`

## 超时与重试（timeoutMs / retries）

**场景**：慢任务设硬超时快速止损；偶发失败（网络/限流/超时）自动重试，不让人守着。

```javascript
// 单 agent 级：60 秒硬超时，可恢复失败重试 2 次（共 3 次尝试）
const r = await agent('深度分析 docs 目录并输出要点清单', {
  label: 'docs分析',
  timeoutMs: 60000,
  retries: 2,
})
```

run 级缺省（工具入参，对本次所有 agent 生效，单 agent 参数优先）：

```
用 workflow 工具执行以下脚本，原样执行不要改动，agentTimeoutMs 传 120000，agentRetries 传 1：

export const meta = { name: 'timeout_retry_demo', description: 'run 级超时重试缺省' }

const r = await Promise.all([
  agent('任务A：分析 README 并总结', { label: 'a' }),
  agent('任务B：分析 docs 并总结', { label: 'b', timeoutMs: 30000 }), // 单 agent 覆盖为 30 秒
])
return r
```

要点：

- `timeoutMs` 毫秒；省略且未设 run 级缺省时不设硬超时；超时报错形如 `agent "x" 超时 (ms)`
- `retries` 上限 3，默认 0；超时属于可重试失败，占用重试次数
- 优先级：单 agent `timeoutMs` / `retries` > 工具入参 `agentTimeoutMs` / `agentRetries` > 不设超时/不重试
- 与质量 DSL 的 `retry` 区分：DSL retry 是「直到 until 条件通过」（对结果不满意就换着再来），`retries` 是「可恢复失败后原样重试」（网络/限流/超时）；两者可叠加

## 带参数执行（args）

**场景**：同一个脚本不改一行代码重跑多种配置（如 A/B 换模型）；或把外部值（文件列表、路径、时间戳）传进沙箱——沙箱禁用 `Date.now()` / `Math.random()`，动态值只能从 `args` 进。

口令（以 examples/sample-project/scripts/node-detail-ab-test.js 为例，换模型重跑）：

```
用 workflow 工具执行 scripts/node-detail-ab-test.js，原样执行不要改动，
args 传 {"model": "biangfeng-gateway/glm-5.2"}
```

脚本侧接收（该脚本的真实写法，缺省回退）：

```javascript
// args.model 可选（"provider/modelId" 形式）；缺省用会话默认模型
const modelOptions = {}
if (args && typeof args.model === 'string') modelOptions.model = args.model

// 展开进 agent 选项：传了就生效，没传就退回默认
const structured = await agent('...', { label: 'schema-reader', ...modelOptions, schema: SCHEMA })
```

要点：

- `args` 是 workflow 工具入参（JSON 对象），脚本内用全局 `args` 读取，任意嵌套层级都行
- 接收处一律先判型再取值（`typeof args.xxx === 'string'`），参数可省不报错
- 与 resume 的交互：args 变了会影响受它控制的 prompt / model，对应调用的哈希随之变化，resume 只回放未受影响的调用（改哪重跑哪，符合预期）
- 纯参数变更不改脚本时，也可用 `resumeFromRunId` 续跑：未变调用直接回放，只重跑参数影响到的部分

## 后台运行长任务

**场景**：大扇出分析（全仓审计、上百文件批处理）要跑几分钟，期间你还想继续对话。

对 Main Agent 说：

```
用 workflow 工具后台执行以下脚本（background: true），...（脚本内容）
```

行为：

- 工具立即返回 runId，本轮对话不阻塞；运行期间可继续与 Main Agent 正常交流
- 完成后结果**自动作为一条消息发回当前会话**，Main Agent 会接力汇报
- 后台 run 不受 Esc 中断影响；用 `workflow_control` 工具管理：
  - `{ "action": "status" }`——列出全部后台 run 与进度（运行中排前，含 X/N agent 统计）
  - `{ "action": "stop", "runId": "run-xxx" }`——停止运行中的 run，已完成部分保留在 journal
- 注意：后台 run 里的人工确认点（checkpoint）不弹窗，直接取缺省值

## 断点续跑（resume）

**场景**：100 个 agent 的批处理跑到 80 个时中断/停止了，不想重烧前 80 个的 token。

步骤：

1. 记下上次结果里的 runId（输出头部与 metadata 都有）
2. 修改脚本（例如换掉综合提示词、追加新的 agent 调用）
3. 重新调用 workflow 工具，带上 `resumeFromRunId: "run-xxx"` 和修改后的脚本

语义（务必理解，否则结果不符合预期）：

- 调用**按位置匹配**：脚本里第 N 个 `agent()` / `checkpoint()` 调用与 journal 里第 N 条记录对比
- 未变化的调用直接从 journal **回放**（不调 LLM、不花 token，摘要状态显示 `[缓存]`）
- 首个发生变化的调用及其后**全部重跑**
- 因此：只改后半段，前半段的调用语句保持原样原序

## 质量 DSL：verify / judgePanel / retry / checkpoint

四个脚本内可直接用的助手，典型用法：

```javascript
// verify：对抗式验证——多个 reviewer 试图反驳结论，票数达阈值判真
const verdict = await verify(agentResult, { reviewers: 3, threshold: 0.5 })
if (!verdict.real) return '结论未通过验证：' + (verdict.reason ?? '')

// judgePanel：评审团选优——多个 judge 按 rubric 给候选打分，返回最高分
const best = await judgePanel([方案A, 方案B, 方案C], { judges: 3, rubric: '正确性与成本' })

// retry：有界重试——until 条件通过即停，耗尽返回最后一次结果（不抛错）
const out = await retry(() => agent('生成配置'), { attempts: 3, until: r => r && r.ok })

// checkpoint：人工确认点——会弹权限确认；确认结果进 journal，续跑回放时不再询问
if (!await checkpoint('即将修改生产配置文件，确认继续？')) return '已取消'
```

适用判断：结论会被下游依赖 → verify；多个生成方案挑一个 → judgePanel；输出格式不稳定 → retry；危险操作前 → checkpoint。参数细节见 DSL 参考的对应小节。

## 组合控制流（sequence / fallback / race / check）

**什么时候用**：多级降级、多路竞争、结构化控制流嵌套（如「失败后修复再验」链）。简单串行（A 完了接 B）继续用普通 await 链，不要机械包进 sequence。

```javascript
// 降级链：任一候选成功即返回；全部可恢复失败返回 null（与 agent 失败同构）
const r = await fallback([
  () => workflow('./fast.js'),
  () => workflow('./strong.js'),
])
if (!r) return '全部路径失败'

// 竞争：首个成功者胜出，其余候选自动取消（含其子工作流），不浪费 token
const best = await race([
  () => workflow('./model-a.js'),
  () => workflow('./model-b.js'),
])

// 确定性闸门：check 过客观事实（false=可恢复失败，fallback 会换候选）
await sequence([
  () => agent('生成配置', { agentType: 'general' }),
  () => check(() => fileExists('config/out.json'), '配置文件必须生成'),
])
```

语义要点：

- 节点返回 `null` / `false` / `{ok:false}` 都是**执行成功**——业务否决自己写 if，不要指望组合节点替你判断
- `checkpoint()` 被拒绝时抛 `CHECKPOINT_REJECTED` 强停止：fallback 不会换候选、parallel 不会塌缩 null；resume 按确定性重现（改 prompt 文本才会重新询问）
- 拼错脚本名、嵌套超限等结构性错误直接上抛，不会被 fallback 伪装成降级
- TUI 侧边栏按 `[Sequence]` / `[Race]` 组合分组显示；checkpoint 显示「等待人工确认 / 已批准 / 被拒绝」

## worktree 隔离（多写型 agent 并行改文件）

**场景**：多个 agent 同时要**修改文件**，共享目录会互相覆盖。

```javascript
await parallel(tasks.map(task => () =>
  agent(`重构 ${task.file} 并说明改动`, { agentType: 'general', isolation: 'worktree' })
))
```

要点：

- 每个 agent 在独立 git worktree（`.opencode-workflows/worktrees/<runId-...>`，分支 `wf/<同名>`）中运行，互不干扰
- 必须配合 `agentType: 'general'`（缺省 explore 只读，写不了文件）
- 非 git 目录或 worktree 创建失败时**静默降级**为共享目录（日志可见），不会报错中断
- 运行结束（含超时/中断）自动拆除 worktree 与分支；**结果不自动合并**——需要保留改动时，让 agent 在脚本里把产物写到指定路径或以文本返回

## 嵌套工作流（原生 workflow() 原语，推荐）

**场景**：把多个 workflow 组合成更大的流程——多阶段流水线、同脚本多配置并行对比、复用既有稳定子流程。

**用法**：脚本内直接 `await workflow(ref, args?)`，不经 LLM 转发（旧 general 代理转发方案已 legacy，见下节）。一个 run 共享并发配额与中断；父脚本可纯编排（零 agent）；结果自带「子流程耗时」段（wall-clock，多配置对比的正确口径）。

```javascript
export const meta = { name: 'full_pipeline', description: '三段式流水线父编排' }

phase('编排')
// 路径引用：上段结果传下段
const spec = await workflow('./scripts/1-spec.js')
const design = await workflow('./scripts/2-design.js', { brief: spec.brief })

// 注册名引用：.opencode-workflows/workflows/ 下的脚本按 meta.id ?? meta.name 寻址
// （含斜杠名如 'ui/main-menu' 合法；与 Schedule 的 workflowId 同一体系）
const report = await workflow('daily-review', { design: design.design })

// 同脚本多实例并行：label 区分（UI/phase/journal 身份）
const rs = await parallel([
  () => workflow({ scriptPath: './sub.js', label: 'deepseek' }, args),
  () => workflow({ scriptPath: './sub.js', label: 'gpt' }, args),
])
```

约束：仅一层嵌套；禁止调用自身/祖先；args 与返回值须可结构化克隆（对象/数组/标量，子内修改不外溢）；子流程错误直接上抛（父 try-catch 自理）。

## 嵌套工作流（旧方案：general 子代理转发，legacy）

**场景**：把多个 workflow 串联成一个更大的流程——上层 workflow 的某个 agent 自己再去执行一个完整的子 workflow（如 根 -> 中间层并行扇出 -> 多个叶子），各层独立计量 token、耗时与 journal。

**原理**：`agent()` 开的是普通子会话；`agentType: 'general'` 的子代理与主会话一样能调用插件工具（含 `workflow`）。**新脚本请用上节原生 `workflow()` 原语**（省一轮 LLM、结果直通、单 run 计量）；本方案保留用于兼容。

```javascript
export const meta = { name: 'chain_root', description: '嵌套链根：串联中间层与叶子两层子 workflow' }

phase('Launch')
// 委托 general 子代理去执行子 workflow（scriptPath 指向子脚本文件）
const middle = await agent(
  '请调用 workflow 工具执行一个子工作流，参数要求：\n' +
  '- scriptPath: "scripts/chain-middle.js"\n' +
  '不要传 background，不要传 script（二选一规则）。必须等子工作流真正执行完成。\n' +
  '完成后把 workflow 返回的最终结果 JSON 原样作为你的回复输出，不要添加解释文字。',
  { label: '子workflow:middle', agentType: 'general', timeoutMs: 600000 },
)

phase('Report')
return { middle }
```

要点：

- **prompt 必须写明**：只传 `scriptPath`、不传 `background`/`script`、等执行完成、结果 JSON 原样回传——否则中间层拿到的是转述而非结构化结果
- 子脚本与普通 workflow 完全一致（可继续嵌套下一层）；`args` 由上层 prompt 里带进子调用
- **TUI 层级树**：嵌套 run 的实时/终态子树直接挂在触发节点名下（缩进一级、细箭头、可独立折叠），主会话侧边栏与全屏 `/workflow` 视图同构；各层 token 独立合计，分层成本可见
- **每层独立**：runId、journal、断点续跑、快照互不干扰；中断后续跑用对应层自己的 runId
- **无深度保护**：嵌套层级无硬限制，编排时自行控层防失控烧 token（每层都有 general 子代理的会话开销）
- 嵌套子代理会话与主会话同目录：快照按 `rootSessionId` 血统归属主会话显示，进程重启后血统丢失则该批嵌套树退化为不可见（不影响执行与结果）

## 定时任务（Schedule）

把稳定 workflow 配置成定时执行，到点由插件内调度器**确定性执行**（直接按 workflowId 加载脚本，不经 LLM 判断）。

### 准备：workflow 脚本放入约定目录

项目根的 `.opencode-workflows/workflows/`，脚本就是普通 workflow（`export const meta = { name: 'daily-review' }`，`meta.id` 可选覆盖 name 作为 workflowId）。

### 创建：自然语言或直接传 cron

```
/schedule 每小时执行 daily-review.js
```

或让 Main Agent 调 `schedule_create` 工具。支持的 cron 四模式（`m`=分 `h`=时 `W`=周几 0-6）：

| 意图 | cron |
|------|------|
| 每 n 分钟 | `*/n * * * *` |
| 每小时 m 分 | `m * * * *` |
| 每天 h 点 m 分 | `m h * * *` |
| 每周 W 的 h 点 m 分 | `m h * * W` |

创建回显含 `Next run` 与 `Requires OpenCode running: Yes` 边界声明。

### 管理与观测

- `schedule_list` / `schedule_get <id>`：下次执行、最近执行历史
- `schedule_update` / `schedule_enable` / `schedule_disable` / `schedule_delete`：改 cron/args/timeout、启停、删除（不删 workflow 文件）
- `schedule_run_now <id>`：立即跑一轮验证（后台执行，结果在独立会话与执行记录里）
- 执行记录：`.opencode-workflows/runs/schedules/<scheduleId>/`，每轮一条 JSON（状态、耗时、token、错误）；每轮一个独立 OpenCode 会话，可在会话列表按时间找到并查看 agent 树
- 重叠保护：上一轮还在跑时新一轮跳过（记录 skipped）；`timeoutMs` 可设单轮超时；定时执行中 `checkpoint()` 直接失败（无人值守不支持人工确认）

### 边界（务必知晓）

OpenCode 关闭期间任务不执行、错过的时间点不补跑（下一个未来时间点正常）；同项目多开 OpenCode 不会重复执行。
