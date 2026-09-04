# opencode-dynamic-workflows

OpenCode 动态工作流插件：Main Agent 生成一段 JavaScript 编排脚本，由 Runtime 在 VM 沙箱中执行，通过 `agent() / parallel() / pipeline()` 将任务分发给大量独立子会话并行处理，脚本内汇总后仅把最终结果返回主上下文——解决大批量并行任务的主上下文污染问题。

参考并移植自 [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)（MIT），底层适配 OpenCode v1 插件 API（`@opencode-ai/plugin` 1.18.27 锁定）。

## 功能（v0.1 最小闭环）

- `workflow` 自定义 tool：接受 JS 脚本，返回结果 + 每个 agent 的单行摘要与 token 用量（metadata）
- VM 沙箱：确定性护栏（禁 `Date.now()` / `Math.random()` / `new Date()` / import / require）
- DSL：`agent(prompt, opts)` / `parallel(thunks)` / `pipeline(items, ...stages)` / `phase(title)` / `log(msg)` / `args`
- 原生结构化输出：`agent(prompt, { schema })` 直接走 OpenCode `format: json_schema`
- 并发控制：缺省 `CPU核数-2`，钳制上限 16；`maxAgents` 缺省 1000
- 超时 / 重试 / abort 级联（Esc 中断主会话会取消所有在飞子会话）
- 分析类 agent 缺省用内置只读 `explore` 子代理

## 安装（公司内部 git 仓库）

```bash
git clone <公司git地址> opencode-dynamic-workflows
cd opencode-dynamic-workflows
npm install
npm run build
```

## 配置

在项目或全局 `opencode.json` 中：

```json
{
  "plugin": ["<克隆目录的绝对路径>"],
  "skills": {
    "paths": ["<克隆目录的绝对路径>/skills"]
  }
}
```

> `plugin` 指向本仓库根目录（读 `dist/index.js`）；`skills.paths` 把 workflow-authoring skill 挂进 OpenCode（skill 同时会成为一个 command），Main Agent 写脚本前会按需加载。

## 验证安装

在 OpenCode 中对 Main Agent 说"用 workflow 并行分析 XX 目录下 10 个文件并汇总"，确认：

1. workflow tool 被调用且生成合法脚本（meta 信封）
2. 子会话挂在当前会话下（父会话内可用 subagent 导航查看）
3. 主会话只收到汇总结果与 agent 摘要，无子会话完整上下文

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test + tsx（18 个用例，fake runner 注入，不调真实 LLM）
npm run build       # 产出 dist/
```

架构约束（详见 AGENTS.md）：`src/runtime/` 宿主无关，OpenCode SDK 只允许出现在 `src/adapters/`，测试在 `AgentSessionRunner` 注入缝上打 fake。

## 阶段规划

v0.1 为最小闭环（P0）。后续：journal/resume、model tier 分层、verify/judgePanel/retry/checkpoint、worktree 隔离、workflow_control、后台执行。详见 `Docs/opencode-dynamic-workflows需求文档.md`。

## License

MIT（沿用 pi-dynamic-workflows）
