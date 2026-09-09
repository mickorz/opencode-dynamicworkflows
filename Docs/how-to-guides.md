# 进阶用法：后台运行、断点续跑、质量 DSL、worktree 隔离

> 四个独立场景，按需取用。DSL 全部参数与语义的权威细节见 [workflow-authoring DSL 参考](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)。

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
