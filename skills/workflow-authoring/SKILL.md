---
name: workflow-authoring
description: 编写 OpenCode 动态工作流 JavaScript 脚本时加载。涉及 workflow tool 的脚本生成、修改、审查、报错排查时使用。
---

# Workflow 编写指南

编写 workflow 脚本时遵守以下规则；细节 API 参考 references/runtime.md，完整范例看 examples/。

## 不变量（违反即报错）

1. 脚本首条语句必须是 `export const meta = { name: 'short_snake_case', description: '一句话说明' }`
2. `agent()` 至少调用一次；纯计算不要用 workflow
3. 禁止 `import` / `require` / `Date.now()` / `Math.random()` / `new Date()`（可确定性重放要求）
4. `parallel()` 接收函数数组，不是 Promise 数组：`() => agent(...)`，返回结果按输入顺序
5. `agent()` 缺省用只读的 explore 子代理；需要写文件时显式传 `{ agentType: 'general' }`

## 可用全局

`agent(prompt, opts?)` `parallel(thunks)` `pipeline(items, ...stages)` `phase(title)` `log(msg)` `args`
`verify(item, opts?)` `judgePanel(attempts, opts?)` `retry(fn, opts?)` `checkpoint(promptText, opts?)`

## 典型形态

```javascript
export const meta = { name: 'fan_out_audit', description: '并行审计多个文件后汇总' }

phase('Scan')
const files = await agent('列出 src/routes 下所有路由文件，每行一个')

phase('Audit')
const findings = await parallel(
  files.split('\n').filter(Boolean).map(file => () => agent(`审计 ${file}，指出风险`))
)

phase('Synthesize')
return await agent('综合以下审计结果，输出风险清单：\n' + findings.join('\n'))
```

## agent() 选项

| 选项 | 说明 |
|------|------|
| `label` | 显示名（metadata 摘要用） |
| `schema` | JSON Schema 对象，返回结构化 JSON |
| `agentType` | OpenCode agent 名；缺省 explore（只读），写任务传 general |
| `model` | "provider/modelId"，如 anthropic/claude-sonnet-4-6 |
| `timeoutMs` | 单 agent 超时毫秒 |
| `retries` | 可恢复失败重试次数（上限 3） |
| `phase` | 显式归属阶段（缺省用当前 phase） |

## 质量与控制助手

```javascript
// 对抗式验证：多 reviewer 试图反驳，投票达阈值判真
const verdict = await verify(agent 的结论, { reviewers: 3, threshold: 0.5 })

// 评审团：多 judge 给多个候选打分，返回最高均分
const best = await judgePanel([方案A, 方案B], { judges: 3, rubric: '正确性与成本' })

// 有界重试：until 通过即停，耗尽返回最后一次结果
const out = await retry(() => agent('生成'), { attempts: 3, until: (r) => r && r.ok })

// 人工确认点：会弹权限确认（允许=true）；回放时不再询问，不花 token
if (!await checkpoint('即将改动生产配置，确认？')) return '已取消'
```

## 参考

- [runtime API 详解](references/runtime.md)
- [范例：扇出汇总](examples/fan-out-and-synthesize.js)
- [范例：分阶段流水线](examples/phased-pipeline-review.js)
