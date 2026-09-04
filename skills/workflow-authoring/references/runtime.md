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
