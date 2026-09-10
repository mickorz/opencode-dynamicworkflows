# opencode-dynamic-workflows

OpenCode 动态工作流插件：Main Agent 生成一段 JavaScript 编排脚本，由 Runtime 在 VM 沙箱中执行，通过 `agent() / parallel() / pipeline()` 将任务分发给大量独立子会话并行处理，脚本内汇总后仅把最终结果返回主上下文——解决大批量并行任务的主上下文污染问题。

底层基于 OpenCode v1 插件 API。

## 30 秒了解

**问题**：让 AI 并行分析 20 个文件时，20 个子任务的过程和结果会全部涌入主会话上下文，很快挤爆窗口、拖慢后续对话。

**方案**：你用自然语言提需求 → Main Agent 自动生成一段编排脚本 → 插件在沙箱里执行它，把任务分发给几十个独立子会话并行跑 → 主会话只收到一份汇总结果 + 每个子任务的耗时与 token 统计。运行期间 TUI 侧边栏还有实时进度树：

![TUI 实时工作流树](assets/tui_workflowtree.png)

点击树上任意节点进入**节点详情视图**：直接查看该 agent 的最终结果（文本或 JSON 美化展示，结构化输出不再是一片空白），附执行元数据（模型、耗时、token、子会话）与 Open Session 入口回看执行过程。

**你不需要会写代码**。编排脚本由 Main Agent 按内置 skill 自动生成；想深入时再参考 [workflow-authoring DSL 参考](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)。

## 前提条件

1. **OpenCode v1 已安装**，且配置了可用的 provider/模型（能正常对话）。未安装见 [OpenCode 官方文档](https://opencode.ai/docs/)。
2. **Node.js 18+ 与 npm**：仅运行安装器（npx）和 npm 操作时需要；插件本体由 OpenCode 内置运行时加载，不依赖本机 Node。
3. Windows 用户请在 **PowerShell 或 cmd** 中运行 npx 命令（git-bash 下 npm 的 bin 转发有兼容问题）。

## 安装

一条命令（在任意目录运行，交互式完成配置合并与 skill 安装，原配置自动留 .bak 备份）：

```powershell
npx @mickorz/opencode-dynamic-workflows install
```

安装完成后**重启 OpenCode** 生效。三种安装方式（全局 / 当前项目 / 锁定版本）的详细说明见 [docs/configuration.md](docs/configuration.md)。

配套命令：

```powershell
npx @mickorz/opencode-dynamic-workflows update      # 升级到最新
npx @mickorz/opencode-dynamic-workflows uninstall   # 交互式卸载
npx @mickorz/opencode-dynamic-workflows doctor      # 环境排查（只读）
```

## 5 分钟快速开始

**第 1 步：验证安装。** 重启 OpenCode 后，对 Main Agent 说：

```
你有哪些工具？
```

工具列表里应出现 `workflow`（问"你有哪些 skills"应看到 `workflow-authoring`）。也可以运行 `npx @mickorz/opencode-dynamic-workflows doctor` 查看环境检查清单。

**第 2 步：跑第一个工作流。** 对 Main Agent 说（原样粘贴）：

```
用 workflow 工具执行以下脚本，原样执行不要改动：

export const meta = { name: 'smoke_test', description: '最小冒烟：3 个 agent' }

phase('Scan')
const info = await agent('列出你当前目录下的文件，只输出前 10 行')

phase('Echo')
const results = await parallel([
  () => agent('用一句话说明什么是工作流编排'),
  () => agent('用一句话说明什么是确定性重放'),
])
return { info, results }
```

**第 3 步：看懂结果。** 工具返回大致如下（数值因模型而异）：

```
工作流 smoke_test 完成：3 个 agent，耗时 11.6s，共 612 tokens（runId: run-xxxxxxx）
阶段: Scan > Echo

agent 摘要:
  [成功] <任务名> (Scan) 120 tok ($0.0012)
  [成功] <任务名> (Echo) 96 tok ($0.0009)
  [成功] <任务名> (Echo) 88 tok ($0.0008)

## 结果
{ "info": "...", "results": ["...", "..."] }
```

三个 agent 全部 `[成功]`、`## 结果` 里有完整 JSON，即跑通。也可以直接说自然语言让 Main Agent 自己生成脚本，例如：

```
用 workflow 并行分析 docs 目录下所有 markdown 文件，然后汇总成一份要点清单
```

**进阶一步：指定模型与结构化返回。** 子任务可指定模型（换成你配置里可用的），并用 schema 约束返回格式：

```
用 workflow 工具执行以下脚本，原样执行不要改动：

export const meta = { name: 'model_schema_demo', description: '指定模型 + schema 约束返回' }

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok', 'summary'] }
const r = await agent('读取当前目录下的 package.json，用一句话总结它的作用', { model: 'openai/gpt-4o-mini', schema: SCHEMA })
return r
```

`r` 直接是 JSON 对象（`r.ok`、`r.summary` 可直接访问），不用自己解析文本。更多见 [how-to-guides](docs/how-to-guides.md) 的「使用不同模型编排」与「schema 结构化返回」两章。

**再进一步：超时与重试。** 慢任务单设超时，可恢复失败（含超时）自动重试：

```
用 workflow 工具执行以下脚本，原样执行不要改动：

export const meta = { name: 'timeout_retry_demo', description: '单 agent 超时与重试' }

// 60 秒硬超时，可恢复失败自动重试 2 次（共 3 次尝试）
const r = await agent('分析 docs 目录并输出要点清单', { label: 'docs分析', timeoutMs: 60000, retries: 2 })
return r
```

要点：`timeoutMs` 毫秒，省略则不设硬超时；`retries` 上限 3，超时属于可重试失败；也可在工具入参里传 `agentTimeoutMs` / `agentRetries` 给整次 run 设缺省，单 agent 的 `timeoutMs` / `retries` 优先。详见 [how-to-guides](docs/how-to-guides.md) 的「超时与重试」章。

**同一个脚本带参数重跑：args。** 脚本里读全局 `args`，口令末尾追加参数，脚本不用改：

```
用 workflow 工具执行 scripts/node-detail-ab-test.js，原样执行不要改动，
args 传 {"model": "biangfeng-gateway/glm-5.2"}
```

脚本侧接收（缺省回退，参数可省）：`const modelOptions = {}; if (args && typeof args.model === 'string') modelOptions.model = args.model`，再把 `...modelOptions` 展开进 `agent()` 选项。沙箱禁用 `Date.now()` / `Math.random()`，外部值（列表、路径、时间戳）都从 `args` 注入。详见 [how-to-guides](docs/how-to-guides.md) 的「带参数执行」章。

## 核心概念

- **子会话隔离**：每个 agent 是独立子会话，父会话内用 subagent 导航可查看各自完整过程；主会话只有汇总。
- **缺省只读**：`agent()` 默认用只读的 explore 子代理；需要写文件的任务显式传 `agentType: 'general'`。
- **后台与续跑**：脚本参数 `background: true` 立即返回 runId 不阻塞对话；中断后 `resumeFromRunId` 可断点续跑，已完成的 agent 不再重复消耗 token。
- **质量助手**：`verify`（对抗式验证）/ `judgePanel`（评审团选优）/ `retry`（有界重试）/ `checkpoint`（人工确认点）。

## 功能一览

- `workflow` 自定义 tool + `workflow_control` 控制 tool（status / stop）
- VM 沙箱确定性护栏（禁 `Date.now()` / `Math.random()` / import / require，可确定性重放）
- DSL：`agent / parallel / pipeline / phase / log / args` + 质量助手
- 原生结构化输出（`schema` 走 OpenCode `format: json_schema`）、并发控制（缺省 CPU 核数-2、上限 16）、超时/重试/abort 级联、git worktree 隔离、journal 断点续跑、后台运行

各功能用法见 [docs/how-to-guides.md](docs/how-to-guides.md)。

## 文档地图

| 文档 | 内容 |
|------|------|
| [docs/getting-started.md](docs/getting-started.md) | 从 0 到第一个工作流的完整教程 |
| [docs/configuration.md](docs/configuration.md) | 三种安装方式、配置字段、升级与卸载 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见问题排查 |
| [docs/how-to-guides.md](docs/how-to-guides.md) | 模型编排、schema 结构化、后台运行、断点续跑、质量 DSL、worktree 隔离 |
| [docs/testing.md](docs/testing.md) | 安装与运行验收清单 |
| [docs/development.md](docs/development.md) | 贡献者指南（架构、测试、本地联调、发布） |
| [workflow-authoring DSL 参考](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md) | 全部 DSL API 的权威细节 |

## License

MIT
