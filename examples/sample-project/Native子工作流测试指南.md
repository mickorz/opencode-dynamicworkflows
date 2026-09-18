# Native 子工作流 workflow() 手动测试指南

> 验收 v0.8 的 Native Workflow Composition（`workflow()` 原语，提交 b45565d）。
> 前置：插件已重新构建（`npm run build`）且 **OpenCode 已重启**（插件进程缓存旧 dist 会报 `workflow is not defined`）。
> 本目录已内置全部验收脚本（`scripts/native/`），按下列 Test 逐项执行。

## 与旧方案（legacy）的对照价值

旧嵌套 = 父脚本里 `agent('请调用 workflow 工具...')` 经 general 子代理转发。Native 版直接 `await workflow('./child.js', args)`。
每项验收都可感受：无中转 LLM、无 parseJsonLoose、结果原样直通、单 run 单 journal。

---

## Test 1：三段流水线（纯编排父，串行 child）

```
读取 scripts/native/pipeline_parent.js 的内容，用 workflow 工具原样执行（scriptPath 传 scripts/native/pipeline_parent.js，前台执行），把返回 JSON 结果字段原样贴出
```

**通过标准**：
- 返回含 `brief / design / code` 三段（`design` 内容引用了 `brief`，`code` 引用了 `design`——args 跨段传递正确）
- 父脚本零 agent（纯编排），全程仅 3 次 LLM 调用（三个 child 各 1）
- `.opencode-workflows/journal/` 新增**一个** run 文件，含 3 条 entry，key 形如 `run-xxx:wf0:0`、`run-xxx:wf1:0`、`run-xxx:wf2:0`
- TUI 会话树（或 journal 的 phase 字段）显示 `▸ native_spec / 需求概述`、`▸ native_design / 概要设计`、`▸ native_code / 伪代码` 三组

## Test 2：parallel 三实例同定义对比

```
用 workflow 工具前台执行 scripts/native/compare_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- 返回数组 3 项，三项内容各含"视角编号 A / B / C"——同脚本三实例的 args 隔离（`{tag:'A'}` 等各自进入 prompt）
- journal 单文件 3 条 entry：`wf0:0 / wf1:0 / wf2:0`（按调用顺序编号）
- phase 前缀用 **label** 区分：`▸ lane_a / 需求概述`、`▸ lane_b / ...`、`▸ lane_c / ...`（同定义 `native_spec` 三实例互不混淆）

## Test 3：args 结构化克隆隔离

```
用 workflow 工具前台执行 scripts/native/mutate_parent.js，把返回 JSON 原样贴出
```

**通过标准**：返回 `{ "counter": 1, "injected": false }`——child 内把 `counter` 改成 999、注入 `injected`，父对象纹丝不动。

## Test 4：错误上抛与父级捕获

```
用 workflow 工具前台执行 scripts/native/error_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- 返回 `{ "caught": true, "message": "child 业务失败：产物闸门未通过" }`——child 的 throw 原样穿透到父，父 try-catch 自理
- 对照：直接前台跑 `error_child.js` 作为根脚本（不经父），workflow 工具应**失败**且错误信息含 `child 业务失败`

## Test 5：自环拒绝

```
用 workflow 工具前台执行 scripts/native/self_ref_parent.js，贴出报错原文
```

**通过标准**：报错含 `不能调用自身或祖先`（child `self_ref.js` 内再调自身被沿链检查拦下；注意报的是自环错而非深度错——更具体的错误优先）。

## Test 6：深度限制

```
读取 scripts/native/self_ref.js，复制为 scripts/native/deep_child.js 并把其中调用的目标改成 './scripts/native/1_spec.js'（即 child 内再调一层 child），然后前台执行一个父脚本：await workflow('./scripts/native/deep_child.js')，贴报错原文
```

**通过标准**：报错含 `嵌套深度超限`（P1 仅一层）。

## Test 7：resume 跨 scope（child 的 agent 回放，不调 LLM）

1. 前台执行 `scripts/native/resume_parent.js`，记下返回的 `runId`（结果 JSON 里）
2. 中断/完成后，让 Main Agent **修改父脚本**：把前置 agent 的 prompt 从 `PARENT-PROBE` 改成 `PARENT-PROBE-2`（保证父的 agent 重跑、child 不变）
3. 用 workflow 工具续跑：`resumeFromRunId=<刚才的 runId>` + 修改后的脚本（scriptPath 同路径，先改文件再续跑）

**通过标准**：
- 父的 agent 重跑（新结果 `PARENT-PROBE-2`）
- **child 的 agent 从 journal 回放**（返回仍是 `RESUME-PROBE`，且本次 run 的 token 消耗只有父那一次 agent 的量级）
- journal 中 child 的 entry key 仍是 `runId:wf0:0`（scoped key 稳定命中）

## Test 8：并发不占用编排额度（死锁防线，可选）

对 `compare_parent.js` 加 `concurrency: 1` 参数执行（workflow 工具的 concurrency 参数）。

**通过标准**：仍正常完成——3 个 child 编排不占并发额度，只有 3 个 agent 在唯一的额度里排队。若实现有误，此处会永久挂起。

---

## 验证手段速查

| 看什么 | 在哪看 |
|--------|--------|
| journal key（wfN 分段） | `.opencode-workflows/journal/<最新runId>.json` 的 entries 键名 |
| phase 前缀分组 | journal entry 的 `phase` 字段 / TUI 会话树的 agent 分组标题 |
| 单 run 汇总 | 一个 runId 一个 journal 文件，agents 全在内（无父子 run 分离） |
| token 含 child | workflow 工具返回的 token/成本统计（三实例对比时 3 份） |
| LLM 调用次数 | OpenCode 会话列表：native 版每 run 只有 agent 子会话，无 general 转发会话 |

## 常见排查

| 现象 | 原因与处理 |
|------|-----------|
| `workflow is not defined` | dist 陈旧：`npm run build` 后**重启 OpenCode** |
| `子脚本不存在或不可读` | scriptPath 相对基准是项目目录（examples/sample-project），检查相对路径 |
| `structured-clone-compatible` 报错 | args 里传了函数/Promise/类实例；只允许对象/数组/标量 |
| `不能调用自身或祖先` | child 调用了自身或祖先脚本路径（大小写变体同样会被拦） |
| `嵌套深度超限` | child 内又调了一层 workflow（P1 限一层）；把孙层逻辑并入 child |
| resume 后 child 没回放 | 子脚本内容变了导致 agent prompt 变、hash 不匹配（属预期：resume 只认 agent 调用内容） |
