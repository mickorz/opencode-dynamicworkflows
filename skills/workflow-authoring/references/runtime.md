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
