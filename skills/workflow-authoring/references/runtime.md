# Runtime API 详解

## 脚本信封

```javascript
export const meta = {
  name: 'short_snake_case',          // 必填，snake_case
  description: '一句话说明',           // 可选
  phases: [{ title: 'Scan' }],       // 可选，声明阶段
}
// meta 必须是纯字面量（对象/数组/字符串/数字/布尔/null），禁止插值/计算属性/方法
```

meta 之后是普通 async 脚本体，顶层可用 `await` 与 `return`。

## agent(prompt, options?) -> Promise<unknown>

分发一个子代理（独立会话）。缺省 agent 为 explore（只读：读文件/grep/搜索），写文件类任务传 `{ agentType: 'general' }`。

- 返回：文本结果（string）或 schema 模式下的 JSON 对象
- `model`：`"provider/modelId"` 完整格式（裸 modelId 报错）；`tier`：层级名（small/medium/big 或自定义），经 `model-tiers.json` 解析，优先级低于 `model`；两者都不传用会话默认模型
- 可恢复失败（网络/超时）重试耗尽后返回 `null`，不抛错
- 不可恢复失败（脚本校验错、agent 超限）直接抛错终止整个 run

```javascript
// 结构化输出
const report = await agent('分析这个文件的风险', {
  label: '风险分析',
  schema: { type: 'object', properties: { risks: { type: 'array', items: { type: 'string' } } } },
})

// 指定模型与只读子代理
const quick = await agent('快速分类', { model: 'openai/gpt-4o-mini' })
```

## parallel(thunks) -> Promise<Array>

并发执行函数数组（自动受并发上限钳制，缺省 CPU核数-2、上限 16）。每个 thunk 内部通常是一个 `agent()` 调用。

```javascript
const results = await parallel(items.map(item => () => agent(`处理 ${item}`)))
// results 与 items 顺序一致；失败位置为 null
```

## pipeline(items, ...stages) -> Promise<Array>

每个 item 依次流过所有 stage，不同 item 之间并发。stage 签名 `(previousValue, originalItem, index)`。

```javascript
const reports = await pipeline(
  files,
  async file => await agent(`读 ${file}`),          // stage 1
  async (summary, file, i) => ({ file, index: i, summary }),  // stage 2：纯 JS 整形
)
```

## phase(title)

标记当前阶段；之后的 agent 归入该阶段（metadata 与摘要展示用）。
## log(message)

记录一行日志，随 tool 结果返回（尾部 20 行）。

## args

调用 workflow tool 时传入的 JSON 对象，作为全局 `args` 暴露。随机数、时间戳等非确定值一律通过 args 注入，不要在脚本内生成。

## 错误处理约定

- `parallel` / `pipeline` 中单个 agent 的可恢复失败 -> 该槽位为 `null`，其余照常
- 需要"失败即终止"的调用，直接 `await agent(...)`（不放进 parallel）
- 脚本内可对 agent 调用自行 try/catch 实现自定义降级

## verify(item, opts?) -> Promise<{ real, realCount, total, votes }>

对抗式评审：`reviewers`（默认 2）个 reviewer agent 尝试反驳 item（字符串或对象），按 `schema` 返回 `{ real: boolean, reason?: string }` 投票；`realCount/total >= threshold`（默认 0.5）判真。`lens` 可给不同 reviewer 分配关注视角。reviewer 失败塌缩为弃权（不计入 total）。

## judgePanel(attempts, opts?) -> Promise<{ index, attempt, score, judgments }>

评审团选优：`judges`（默认 3）个 judge 按 `rubric`（默认 overall quality and correctness）给每个非空候选打 0-1 分，候选得分为评审均分；返回最高分候选（同分取输入顺序靠前者），`index` 为原始下标（null 候选被过滤但下标不变）。

## retry(fn, opts?) -> Promise<unknown>

有界重试糖：`fn(attempt)` 反复执行（`attempts` 默认 3），`until(result)` 通过即返回；耗尽返回最后一次结果（不抛错）。fn 内的 agent() 调用各自 journal，resume 安全。

## checkpoint(promptText, opts?) -> Promise<unknown>

人工确认点（仅确认型）：有 UI 通道时弹权限确认（允许=true/拒绝=false）；无通道时取 `opts.default`（缺省 true），`headless: "abort"` 则抛错终止。确认结果进 journal——resume 回放不再询问，不花 token。返回值是布尔，脚本按分支处理。

## 迭代与续跑（resume）

workflow tool 支持 `resumeFromRunId`：修改脚本后重传上次结果的 runId，未变的 agent()/checkpoint() 调用直接从 journal 回放（不调 LLM），首个变更调用及其后全部重跑。调用按位置匹配——保持前序调用不变且有序。

## agent() 的 isolation 选项（P1-5）

```javascript
await agent('重构 src/player.ts 并提交修改说明', { isolation: 'worktree', agentType: 'general' })
```

- 在独立 git worktree（`.opencode-workflows/worktrees/<runId-callIndex-label>`，分支 `wf/<同名>`）中运行该 agent 的会话，多个写型 agent 互不覆盖文件
- 需要写文件时配合 `agentType: 'general'`（缺省 explore 是只读的）
- 语义：opt-in 按 agent 开启；非 git 目录或创建失败时**静默降级**为共享目录（日志可见）；运行结束（含超时/中断）自动拆除 worktree 与分支；**结果不自动合并**——改动留在 worktree 生命周期内，需要保留产物时在脚本里让 agent 把结果写入指定路径或以文本返回

## 后台运行与控制（tool 参数，非脚本全局）

缺省即后台（background 省略等价 true）：立即返回 runId、本轮对话不阻塞；完成后结果自动作为一条消息发回当前会话，Main Agent 会接力汇报。后台 run 不受 Esc 影响，控制走 `workflow_control` 工具：

- `workflow_control({ action: "status" })`：列出全部后台 run 与进度（X/N agent）
- `workflow_control({ action: "stop", runId })`：停止运行中的 run（已完成的 agent 结果在 journal，可用 `workflow(resumeFromRunId)` 续跑）

适用：长跑批量任务（大扇出分析、全仓审计）且期间想继续对话。后台 run 的 checkpoint 走 headless 默认值（无人工弹窗）；需要 checkpoint 人工确认或同步拿结果时显式传 `background: false` 走前台。两个例外即使显式传 true 也强制前台：agent 嵌套会话内调用（中间层需同步拿结果继续编排）、resumeFromRunId 续跑（后台未接 journal 回放）。

## 嵌套工作流（原生 workflow 原语，v0.8 推荐）

### 何时选 workflow()

| 需求形态 | 用法 |
|----------|------|
| 多阶段流水线（各阶段已独立成脚本） | 串行 await，上段返回值作下段 args |
| 同一子脚本多配置/多模型对比 | parallel 包裹，label 区分实例 |
| 复用既有稳定 workflow 作大流程一环 | 单点 await 直入 |
| 纯编排（父只组装/汇总，自己不调 agent） | 父零 agent 合法（不变量校验的是整个 run） |
| 只是并行多个 **agent**（无子脚本） | 不要用 workflow()，直接 parallel + agent |
| 需要子流程可独立单独跑/单独定时 | 拆子脚本后既可被 workflow() 组合，也可直接跑或配 Schedule |

### 子流程观测（v0.9）

含子流程的 run，结果自带「子流程耗时」段：

```
子流程耗时（wall-clock ≠ agent 时长之和，并行时以 wall 为准）:
  native_compare / lane_a：wall 10.3s，agent 合 10.3s，101 tokens
  native_compare / lane_b：wall 164.7s，agent 合 164.6s，585 tokens
```

- **对比多配置/多模型时以 wall-clock 为准**（agent 时长之和会把并行的重叠时间重复计入）
- TUI 按子流程一级分组（粗体行）+ phase 二级；journal 的 agent 记录带 `workflowPath`（label 链）与 `workflowScopePath`（keySegment 链）双身份
- 子流程执行态只描述 runtime（正常 return 即 ok，`{ok:false}` 之类的业务结果不影响）；`meta.id` 会被记录进执行记录（无则缺省）

### 两种引用方式（v0.10 Registry）

```js
await workflow('./scripts/1-spec.js')          // 路径：./ ../ 或绝对路径
await workflow('daily-review', args)           // 注册名：.opencode-workflows/workflows/ 下
await workflow('ui/main-menu')                 // 含斜杠的注册名也合法（按 meta.id ?? meta.name 寻址）
await workflow({ scriptPath: 'daily-review', label: 'deepseek' }, args)  // 名字 + 实例显示名
```

名字解析 per-run 缓存（首查扫描注册目录，运行中新增脚本不影响进行中 run）；与 Schedule 的 workflowId 同一体系——同一脚本既能定时也能被组合引用。未找到时报错并列出已知名。

不再需要经 general 子代理转发——直接在脚本内调用：

```js
// 串行：上段结果传入下段
const spec = await workflow('./scripts/1-spec.js')
const design = await workflow('./scripts/2-design.js', { brief: spec.brief })

// 并行：同脚本多实例，label 区分（UI/phase/journal 身份）
const rs = await parallel([
  () => workflow({ scriptPath: './sub.js', label: 'deepseek' }, args),
  () => workflow({ scriptPath: './sub.js', label: 'gpt' }, args),
])
```

约定：
- 一个 Root Run：父子共享并发配额（maxAgents）、中断信号、journal 与统计；子 workflow 不占并发额度（只限 agent）
- args 与返回值经 structuredClone 隔离（子内修改不影响父对象）；须为可克隆数据（对象/数组/标量）
- 子内 phase 自动带 `▸ label / ` 前缀，TUI 按前缀分组；同定义多实例靠 label 区分
- journal key：root 为 `runId:N`（旧格式兼容），child 为 `runId:wfK:N`（按调用顺序编号，稳定可 resume）
- 错误直接上抛（父 try-catch 自理）；仅支持一层嵌套；禁止调用自身/祖先脚本
- 父脚本可纯编排（零 agent，全部经子 workflow dispatch）

常见报错速查：

| 报错 | 原因 |
|------|------|
| `子脚本不存在或不可读` | scriptPath 相对基准是**项目根目录**，检查路径 |
| `structured-clone-compatible` | args 传了函数/Promise/类实例；只允许对象/数组/标量 |
| `不能调用自身或祖先` | 子脚本调用了自己或上层脚本（大小写变体同样拦） |
| `嵌套深度超限` | 子内又嵌了一层（P1 限一层）；把孙层逻辑并入子脚本 |
| `至少调用一次 agent` | 整个 run（含子流程）一次 agent 都没调，也没 checkpoint |
| resume 后子流程没回放 | 子脚本内容变了致 agent hash 不匹配（预期：resume 只认 agent 调用内容） |

## 嵌套工作流（旧方案：general 子代理转发，legacy）

脚本沙箱内没有 `workflow()` 全局；要串联多层大流程，让 `agentType: 'general'` 的子代理去调用 workflow 工具（general 与主会话一样可用插件工具，缺省的 explore 只读白名单调不了）：

```javascript
const middle = await agent(
  '请调用 workflow 工具执行一个子工作流，参数：scriptPath 为 "scripts/chain-middle.js"。' +
  '不要传 background 与 script。等子工作流执行完成后，把最终结果 JSON 原样作为回复输出。',
  { label: '子workflow:middle', agentType: 'general', timeoutMs: 600000 },
)
```

约定：

- prompt 必须写明"scriptPath only、等完成、结果 JSON 原样回传"，防止中间层拿到转述；嵌套会话内即使不传 background 也强制前台（中间层需同步拿工具返回值）
- 结果经子代理文本回复回传，是字符串；需要结构时自行 JSON 解析容错
- 每层独立 runId / journal / token 计量；TUI 层级树把嵌套子树挂在触发节点名下
- 嵌套无深度保护，自行控层防失控
