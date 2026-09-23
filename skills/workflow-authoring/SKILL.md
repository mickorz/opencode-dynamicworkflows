---
name: workflow-authoring
description: 编写 OpenCode 动态工作流 JavaScript 脚本时加载。涉及 workflow tool 的脚本生成、修改、审查、报错排查时使用。
---

# Workflow 编写指南

编写 workflow 脚本时遵守以下规则；细节 API 参考 references/runtime.md，完整范例看 examples/。

## 不变量（违反即报错）

1. 脚本首条语句必须是 `export const meta = { name: 'short_snake_case', description: '一句话说明' }`；可选 `id`（稳定标识，可含斜杠如 `ui/main-menu`，供按名引用与定时寻址；缺省回落 name）
2. 整个 run 至少一次 agent dispatch：直接调 `agent()`，或经 `workflow()` 子流程间接（纯编排父脚本合法）；两者都没有的纯计算不要用 workflow
3. 禁止 `import` / `require` / `Date.now()` / `Math.random()` / `new Date()`（可确定性重放要求）
4. `parallel()` 接收函数数组，不是 Promise 数组：`() => agent(...)`，返回结果按输入顺序
5. `agent()` 缺省用只读的 explore 子代理；需要写文件时显式传 `{ agentType: 'general' }`

## 可用全局

`agent(prompt, opts?)` `parallel(thunks)` `pipeline(items, ...stages)`（等价于 parallel+sequence 组合，新脚本优先组合写法） `phase(title)` `log(msg)` `args`
`setConcurrency(n)`（运行中调并发上限：正整数、钳 16；调大立即放行排队者，调小不抢占存量）
`verify(item, opts?)` `judgePanel(attempts, opts?)` `retry(fn, opts?)` `checkpoint(promptText, opts?)`
`sequence(nodes)` `fallback(nodes)` `race(nodes)`（Composite 组合控制流，见下下节）
`workflow(ref, args?)`（原生子工作流：ref 为脚本路径（`./x.js`/`../x.js`/绝对路径）或**注册名**（`.opencode-workflows/workflows/` 下脚本的 meta.id ?? meta.name，含斜杠名合法）；可传 `{ scriptPath, label? }` 带实例显示名；同 run 共享配额/中断/journal；args 与返回值克隆隔离；仅一层嵌套；父可纯编排；详见 references/runtime.md）

## 子 workflow 组合（workflow 原语）

遇到以下需求时用 `workflow()` 原语，**不要**让 agent 转发调用 workflow 工具（旧方案已 legacy）：

- 多阶段流水线：需求分析 -> 设计 -> 编码，各阶段已是独立 workflow 脚本
- 同一子脚本多配置/多模型对比（同定义多实例，label 区分）
- 复用既有稳定 workflow 作为大流程的一环
- 纯编排：父脚本只做组装/传参/汇总，自己不调 agent

```javascript
// 串行：上段结果传入下段；父脚本零 agent 合法
const spec = await workflow('./scripts/1-spec.js')
const design = await workflow('./scripts/2-design.js', { brief: spec.brief })

// 并行：同脚本三实例，label 区分（UI/phase/journal 身份）
const rs = await parallel([
  () => workflow({ scriptPath: './sub.js', label: 'deepseek' }, args),
  () => workflow({ scriptPath: './sub.js', label: 'gpt' }, args),
])
```

关键约束（细节见 references/runtime.md）：
- scriptPath 相对项目根目录（或按注册名引用）；嵌套默认最多 3 层（workflow 工具的 maxWorkflowDepth 可调）；禁止调用自身/祖先脚本（沿链检查，隔层祖先也拦）
- args 与返回值必须是可克隆数据（对象/数组/标量）；子内修改不影响父对象
- 子脚本错误直接上抛，父 try-catch 自理；返回 `{ok:false}` 之类的业务结果不影响执行成功
- 同 run 共享并发配额与中断；子内 phase 自动带 `▸ label / ` 前缀分组；结果带「子流程耗时」段（wall-clock，并行对比的正确口径）

## 组合控制流（Composite：sequence / fallback / race）

**使用边界（重要，不要滥用）：**

- 简单串行（A 完了接 B）→ **继续用普通 await 链**，不要机械地把所有 await 包进 sequence
- Composite 只在这些场景用：多级候选降级（fallback）、多路竞争择优（race）、与 sequence/parallel 嵌套组成结构化控制流（如「失败后修复再验」链、决策树）

```javascript
// 降级链：快模型不行换强模型，再不行规则兜底；任一成功即返回其结果
const result = await fallback([
  () => workflow('./fast.js'),
  () => workflow('./strong.js'),
  () => ({ source: 'rule-based', data: [] }),
])
if (!result) return '全部降级路径失败'

// 多路竞争：任一成功即胜出，其余自动取消（不浪费 token）
const best = await race([
  () => workflow('./model-a.js'),
  () => workflow('./model-b.js'),
])

// 嵌套组合：「失败后修复再验」的链，作为 fallback 的第二候选
await fallback([
  () => workflow('./verify.js'),
  () => sequence([
    () => workflow('./fix.js'),
    (prev) => workflow('./verify.js', { fixed: prev }),
  ]),
])
```

语义规则（细节见 references/runtime.md）：
- 节点返回任意值（含 `null` / `false` / `{ok:false}`）都是**执行成功**；业务否决自己写 if 判断，不要指望组合节点替你判断
- 可恢复失败：sequence 立即停止返回 `null`；fallback 换下一候选；race 等其余候选——三者与 `agent()` 可恢复失败返回 `null` 同构，`if (!r)` 判断即可
- 拼错脚本名 / 嵌套超限 / 非函数数组等**结构性错误直接抛错**，不会被 fallback 吞掉伪装成降级
- race 胜出后其余候选被局部取消（仅限 race 内部，不中断整个 run）
- 三者不占 journal 位，resume 行为与普通 await 链一致

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

纯编排父（零 agent，全部经子 workflow，返回值直接组装）：

```javascript
export const meta = { name: 'full_pipeline', description: '三段式流水线父编排' }
phase('编排')
const spec = await workflow('./scripts/1-spec.js')
const design = await workflow('./scripts/2-design.js', { brief: spec.brief })
const code = await workflow('./scripts/3-code.js', { design: design.design })
return { brief: spec.brief, design: design.design, code: code.code }
```

## agent() 选项

| 选项 | 说明 |
|------|------|
| `label` | 显示名（metadata 摘要用） |
| `schema` | JSON Schema 对象，返回结构化 JSON |
| `agentType` | OpenCode agent 名；缺省 explore（只读），写任务传 general |
| `model` | "provider/modelId"，如 anthropic/claude-sonnet-4-6 |
| `isolation` | `"worktree"` 独立 git worktree 隔离（写型任务配合 agentType general） |
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

## 交付前语法自检（必做）

生成或修改 workflow 脚本后、写盘交付前，先跑本 skill 自带的语法检查：

```bash
node <skill 目录>/scripts/wf-syntax-check.cjs <脚本路径> [更多脚本...]
```

- 检查原理：`export const meta` 降级为 `const meta` 后包进 async IIFE，用 vm 编译——支持 workflow 的顶层 await 与 return（`node --check` 不支持顶层 return，故不能替代）
- 退出码 0 全通过；1 时按报错（含行号）修完再交付
- 典型拦获：括号不闭合、await 漏包、引号错配、模板字符串反引号丢失

## 参考

- [runtime API 详解](references/runtime.md)
- [Schedule 定时执行](references/schedule.md)
- [范例：扇出汇总](examples/fan-out-and-synthesize.js)
- [范例：分阶段流水线](examples/phased-pipeline-review.js)
