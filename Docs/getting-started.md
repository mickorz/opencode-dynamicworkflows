# Getting Started：从 0 到第一个工作流

> 面向完全不了解本项目的读者。完成本教程约需 10 分钟，结束后你将跑通一个 3 个子代理并行工作的工作流，并读懂它的全部输出。

## 0. 你将完成什么

对 AI 说一句"并行分析这些文件"，插件会：

1. 让 Main Agent 生成一段编排脚本（你不用写代码）
2. 在沙箱里执行脚本，把任务分发给多个独立子会话**并行**执行
3. 在 TUI 侧边栏实时展示进度树
4. 只把**汇总结果**和每个子任务的耗时/token 统计返回主会话——中间过程不会污染你的对话上下文

## 1. 前提条件

| 条件 | 说明 | 检查方法 |
|------|------|---------|
| OpenCode v1 | 已安装并配置好 provider/模型（能正常对话） | 终端运行 `opencode --version` 输出 1.x |
| provider/模型 | OpenCode 里能正常聊天 | 在 OpenCode 里随便问一句话 |
| Node.js 18+ 与 npm | 仅 npx 安装器和 npm 操作需要 | `node --version` 输出 v18 或更高 |

未安装 OpenCode 见[官方文档](https://opencode.ai/docs/)。Windows 用户请在 PowerShell 或 cmd 中运行下文所有 npx 命令。

## 2. 安装插件

在任意目录运行：

```powershell
npx @mickorz/opencode-dynamic-workflows install
```

交互式流程：

1. 检测 OpenCode 版本（非 v1 会确认）
2. 选择安装方式——第一次建议选**全局安装**（所有项目生效）
3. 是否安装 skill——选**是**（workflow-authoring 是 Main Agent 写脚本的说明书）
4. 确认变更清单后执行；原有配置自动留 `.bak` 备份

安装器会修改两份配置（`opencode.json` 与 `tui.json` 各加一条 `plugin`），并把两个 skill 拷贝到 `~/.config/opencode/skills/`。

## 3. 重启并验证

**重启 OpenCode**（配置只在启动时读取），然后：

1. 问 Main Agent：`你有哪些工具？`——列表里应有 `workflow`
2. 问：`你有哪些 skills？`——应有 `workflow-authoring`
3. （可选）TUI 里 ctrl+p → Plugins——插件应显示 active；之后每次运行工作流，sidebar 会出现实时进度树
4. （可选）终端运行 `npx @mickorz/opencode-dynamic-workflows doctor`——应全是 [OK]，输出示例：

```
[OK] Node.js v24.18.0
[OK] npm 11.16.0
[OK] OpenCode 1.18.30
...
检查完成：N 项 OK，0 项 WARN，0 项 FAIL
```

缺 `workflow` 或缺 skill 时，直接跳到 [troubleshooting](troubleshooting.md)。

## 4. 跑第一个工作流

对 Main Agent 原样粘贴：

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

这段脚本的含义：先 1 个 agent 列目录（Scan 阶段），再 2 个 agent 并行回答两个问题（Echo 阶段），最后把三个结果打包返回。

运行期间 sidebar 出现实时树属正常现象；整个脚本通常几十秒内完成。

## 5. 读懂结果

工具返回分四部分：

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

（数值因模型而异；cost 行仅在 provider 返回成本数据时出现）

- **头部统计**：agent 总数、失败/中止数、总耗时、总 token、runId（续跑与查询进度时用）
- **agent 摘要**：每个子会话一行——状态（成功/失败/中止/缓存）、归属阶段、token 消耗；`[缓存]` 表示该结果来自上次运行的 journal 回放，没花 token
- **`## 结果`**：脚本 `return` 的值（JSON 格式），这是你真正要看的产出
- **尾部提示**：`提示：迭代不重烧——修改脚本后重传 resumeFromRunId=...`，断点续跑入口，见 [how-to-guides](how-to-guides.md)

两个"看不到"是**设计如此**，不是故障：

1. 主会话消息里只有一次工具调用和一份结果，看不到子会话的中间过程——这正是插件的目的（上下文隔离）。想看某个子任务干了什么，在父会话内用 subagent 导航切换。
2. 子会话不会出现在普通会话列表里（平台过滤了子会话），同样从父会话的 subagent 导航进入。

## 6. 试第二个：自然语言版

上面是你手动递脚本；平时直接说需求，Main Agent 会自己生成脚本：

```
用 workflow 并行分析 docs 目录下所有 markdown 文件的核心内容，然后汇总成一份要点清单
```

观察它生成的脚本你会发现固定套路：`phase` 分阶段 → `parallel` 并行分析 → 最后一个 agent 综合汇总。这套"扇出-汇总"模式是本插件最常用的形态，更多范例见 skill 内置的 [fan-out-and-synthesize.js](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/examples/fan-out-and-synthesize.js)。

## 7. 下一步与求助

- 长任务放后台、断点续跑、质量 DSL、写文件任务 → [docs/how-to-guides.md](how-to-guides.md)
- 三种安装方式、升级卸载 → [docs/configuration.md](configuration.md)
- 出问题 → [docs/troubleshooting.md](troubleshooting.md)
- DSL 全部 API → [workflow-authoring DSL 参考](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)
