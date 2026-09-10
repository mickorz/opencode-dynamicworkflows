# 常见问题排查

> 排查任何问题的第一步：终端运行 `npx @mickorz/opencode-dynamic-workflows doctor`（只读检查，输出 [OK]/[WARN]/[FAIL] 清单），把 FAIL 项对照下表处理。

## 安装类

**工具列表里没有 `workflow`**

1. 确认改的是**两份**配置：`opencode.json` 和 `tui.json` 都需要 `plugin` 条目
2. 确认改完**重启了 OpenCode**（配置只在启动时读取）
3. `npm view @mickorz/opencode-dynamic-workflows version` 能看到版本号；看不到说明 npm 源异常或新发版还在 CDN 缓存中（等几分钟再试）
4. 检查包缓存目录是否完整：`~/.cache/opencode/packages/@mickorz/opencode-dynamic-workflows/`（Windows PowerShell：`dir $env:USERPROFILE\.cache\opencode\packages\@mickorz`）

**skill 列表里没有 `workflow-authoring`**

- 用安装器装的：确认 `~/.config/opencode/skills/workflow-authoring/SKILL.md`（全局）或项目 `.agents/skills/`（项目级）存在，然后重启 OpenCode
- 手动配置的：确认 `skills.paths` 指向包内 `skills` 目录，且相对路径基准是 **OpenCode 启动目录**（不是配置文件目录，两者容易搞混）

**TUI 里插件不显示 active / sidebar 没有实时树**

- 只影响实时树展示，工作流功能本身不受影响
- 检查 `tui.json` 是否配置了 `plugin` 条目（TUI 侧与 opencode.json 分离，不自动继承）

**npx 命令报"不是内部或外部命令"（git-bash）**

- Windows 的 git-bash 对 npm bin 转发有兼容问题；改用 PowerShell 或 cmd 运行 npx 命令

**npx 跑的是旧版本**

- npx 缓存可能钉住旧版。doctor 检测到"CLI 版本落后于 npm 最新"时会 WARN；强制用最新：`npx @mickorz/opencode-dynamic-workflows@latest ...`

## 运行类

**脚本报错与 `meta` 相关**

- 首条语句必须是 `export const meta = { name: 'xxx', description: '...' }`，且 meta 必须是纯字面量
- 让 Main Agent 执行脚本时强调"原样执行不要改动"；markdown 围栏会被自动剥离

**脚本报错禁用 API（Date.now 等）**

- 沙箱禁止 `import` / `require` / `Date.now()` / `Math.random()` / `new Date()`（确定性重放要求）
- 时间戳、随机值改为通过 workflow 工具的 `args` 参数注入，脚本内用全局 `args` 读取

**agent 报 `agent "x" 超时 (ms)`**

- 单 agent 调大或省略 `timeoutMs`（省略且未设 run 级缺省则不设硬超时）；run 级调 `agentTimeoutMs` 入参
- 注意超时会占用 `retries` 重试次数：重试也超时说明任务本身太慢，先拆小任务或换模型

**agent 返回 null 或全部 null**

- 可恢复失败（网络/超时/限流）重试耗尽后该 agent 返回 null，不抛错——重跑一次即可；频繁出现加 `agentRetries: 2` 参数（上限 3）
- 单个 agent 想失败即终止，不要放进 `parallel`，直接 `await agent(...)`

**agent 报 `agent model 必须是 provider/modelId 格式`**

- `model` 参数必须是完整 `"provider/modelId"`（如 `openai/gpt-4o-mini`），裸 `modelId` 会被拒绝
- 不知道 provider 前缀：看 `opencode.json` 里 `model` 字段的写法，照抄前缀

**log 出现 `tier "xxx" 未配置，回退会话默认模型`**

- tier 名没在配置文件里：全局 `~/.config/opencode/workflows/model-tiers.json` 或项目 `.opencode-workflows/model-tiers.json` 加上对应键（不中断运行，只是回退默认模型）

**schema 模式 agent 直接失败（provider_bad_request / 400）**

- 结构化输出依赖模型支持 tool_choice required；部分网关/模型不支持（实测某些 OpenAI 兼容网关返回 400）
- 换支持结构化输出的模型，或去掉 `schema` 用自然语言输出

**写文件的任务"跑完没效果"**

- `agent()` 默认用只读的 explore 子代理。写文件需显式传 `agentType: 'general'`，多写型任务互不覆盖可再加 `isolation: 'worktree'`

**Esc 中断后后台任务还在跑**

- 前台工作流 Esc 即全部取消（abort 级联）；但 `background: true` 启动的后台 run **不受 Esc 影响**（设计如此），用 `workflow_control` 工具停止：`{ "action": "stop", "runId": "run-xxx" }`

**续跑报"找不到 run 的 journal"**

- journal 落盘在**启动 OpenCode 的项目目录**下 `.opencode-workflows/journal/<runId>.json`；换目录启动会导致找不到，回到原目录或省略 `resumeFromRunId` 开新 run

## 现象确认类（不是故障）

| 现象 | 说明 |
|------|------|
| 主会话看不到子任务的中间过程 | 设计目的：上下文隔离。细节在子会话里，父会话内 subagent 导航查看 |
| 子会话不在会话列表里 | 平台过滤了子会话；从父会话的 subagent 导航进入 |
| Main Agent 回复只说"见上方 JSON 输出" | 综合结果在工具返回的 `## 结果` JSON 块里；想展开就说"把结果里的总览完整复述出来" |
| agent 摘要状态为 `[缓存]` | 结果来自上次运行的 journal 回放（断点续跑/重跑未变部分），未消耗 token |
| 带 schema 的节点，点击进子会话正文是空白 | 结构化输出的正常形态：结果在 StructuredOutput 工具调用里，不在 assistant 正文。workflow 返回值与 journal 里的结果完整无损，以它们为准 |
| 结果 JSON 末尾有"结果过大已截断" | 工具输出有 50KB 平台预算；完整结构仍在 metadata 中 |

## 仍然解决不了

1. 收集 `doctor` 完整输出
2. 取 OpenCode 日志尾部：`%USERPROFILE%\.local\share\opencode\log\opencode.log`（Linux/mac：`~/.local/share/opencode/log/`）
3. 到 [GitHub Issues](https://github.com/mickorz/opencode-dynamicworkflows/issues) 提交，附上以上信息与复现步骤
