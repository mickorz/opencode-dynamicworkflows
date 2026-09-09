# opencode-dynamic-workflows

OpenCode 动态工作流插件：Main Agent 生成一段 JavaScript 编排脚本，由 Runtime 在 VM 沙箱中执行，通过 `agent() / parallel() / pipeline()` 将任务分发给大量独立子会话并行处理，脚本内汇总后仅把最终结果返回主上下文——解决大批量并行任务的主上下文污染问题。

参考并移植自 [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)（MIT），底层适配 OpenCode v1 插件 API（`@opencode-ai/plugin` 1.18.27 锁定）。

## 功能（v0.1 最小闭环）

- `workflow` 自定义 tool：接受 JS 脚本，返回结果 + 每个 agent 的单行摘要与 token 用量（metadata）
- VM 沙箱：确定性护栏（禁 `Date.now()` / `Math.random()` / `new Date()` / import / require）
- DSL：`agent(prompt, opts)` / `parallel(thunks)` / `pipeline(items, ...stages)` / `phase(title)` / `log(msg)` / `args`
- 后台运行：`background: true` 立即返回 runId，完成后结果自动回传会话；`workflow_control` 工具查进度/停止
- 原生结构化输出：`agent(prompt, { schema })` 直接走 OpenCode `format: json_schema`
- 并发控制：缺省 `CPU核数-2`，钳制上限 16；`maxAgents` 缺省 1000
- 超时 / 重试 / abort 级联（Esc 中断主会话会取消所有在飞子会话）
- 分析类 agent 缺省用内置只读 `explore` 子代理

## 安装

无需手动安装。OpenCode 启动时自动从 npm 拉包并缓存到 `~/.cache/opencode/packages/`，只需在配置里声明包名（见下）。手动 `npm install @mickorz/opencode-dynamic-workflows` 仅在需要引用包内 skills 路径时才有必要。

## 配置

分全局与项目级两层，二选一或叠加（同包同版只加载一次，不冲突）。改完配置需重启 OpenCode。

### 方式一：全局配置（推荐，一次配置所有项目生效）

`~/.config/opencode/opencode.json`（server 侧）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

`~/.config/opencode/tui.json`（TUI 侧，与 opencode.json 分离，不会自动继承，必须独立配置）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

两个文件都配好后，任何工程目录启动 opencode 即生效，无需在项目里做任何事。

### 方式二：项目级配置（发给同事 / 不想全局生效）

目标项目根目录两个文件：

`opencode.json`：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json`（与 opencode.json 同目录）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

> `plugin` 指向包名（server 侧读包内 `dist/index.js`）；项目级 `skills.paths` 需要先在项目里 `npm install @mickorz/opencode-dynamic-workflows`，把 workflow-authoring skill 挂进 OpenCode（skill 同时会成为一个 command），Main Agent 写脚本前会按需加载。`skills.paths` 相对路径基准是 OpenCode 启动目录。

> TUI 进程经 `exports["./tui"]` 加载 `src/tui/index.tsx`（bun 直接读 TSX 源码，无需 build）。配置后 ctrl+p → Plugins 应看到插件在 TUI 侧 active。前台 workflow 运行期间 sidebar 出现 Dynamic Workflow 实时树。

### 方式三：项目 node_modules 引用（版本随项目锁定，团队协作推荐）

先把包装进项目依赖（版本写入 package.json，随 git 提交，团队成员 npm install 后即用，不依赖 OpenCode 全局缓存）：

```bash
cd E:/WorkProjects/xc-flow
npm install @mickorz/opencode-dynamic-workflows
```

然后配置里不写包名，写相对路径引用项目 node_modules 里的包（`./` 开头的路径按配置文件所在目录解析）：

`opencode.json`：

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json`（与 opencode.json 同目录）：

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"]
}
```

升级走 npm：`npm update @mickorz/opencode-dynamic-workflows`，无需清 OpenCode 缓存。三种方式对比：

| 方式 | 生效范围 | 版本管理 | 适用场景 |
|------|---------|---------|---------|
| 一：全局配置 | 所有项目 | 全局缓存，删缓存升级 | 个人机器统一用最新 |
| 二：项目级包名 | 单项目 | 全局缓存（同上） | 仅个别项目启用 |
| 三：项目 node_modules 引用 | 单项目 | 项目 package.json 锁定 | 团队协作、离线/内网、版本一致性要求高 |

### 升级插件版本

删除包缓存后重启，OpenCode 会重新拉取最新版：

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.cache\opencode\packages\@mickorz
```

### 排查

- 插件没装上：OpenCode 启动时自动装 npm 插件，失败不阻塞启动（静默跳过）。按序检查：
  1. `npm view @mickorz/opencode-dynamic-workflows version` 能看到版本（新发版的 metadata 可能被 CDN 缓存 404 几分钟）
  2. `dir $env:USERPROFILE\.cache\opencode\packages\@mickorz\opencode-dynamic-workflows\node_modules\@mickorz\opencode-dynamic-workflows` 包文件是否齐全（1.18.29 实际安装位置是 `packages/` 而非文档写的 `node_modules/`）
  3. TUI 加载链路看 Temp vendor 目录：`dir $env:TEMP\opencode-dynamic-workflows-vendor-<版本>\`，`src\` 下 3 个实现文件 + `node_modules` junction 都在才算通过
- 日志：`$env:USERPROFILE\.local\share\opencode\log\opencode.log`（大文件注意取尾部）

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

本地联调：在 `examples/sample-project/` 启动 OpenCode，其 opencode.json / tui.json 以相对路径 `"../.."` 指向仓库根，改 server 侧代码后需重新 build，TUI 侧重启即生效。

架构约束（详见 AGENTS.md）：`src/runtime/` 宿主无关，OpenCode SDK 只允许出现在 `src/adapters/`，测试在 `AgentSessionRunner` 注入缝上打 fake。

## 阶段规划

v0.1 为最小闭环（P0）。后续：journal/resume、model tier 分层、verify/judgePanel/retry/checkpoint、worktree 隔离、workflow_control、后台执行。详见 `Docs/01_需求与规划/opencode-dynamic-workflows需求文档.md`。

## License

MIT（沿用 pi-dynamic-workflows）
