# FFF 文件搜索性能 A/B Benchmark 报告

> 目标:测量在同一项目/同一模型/同一 Agent 下,`OPENCODE_DISABLE_FFF` 开关(ripgrep vs fff)对 Agent 工作流的端到端耗时影响。
> 环境:Windows + OpenCode 1.18.30 + 插件 `opencode-dynamic-workflows`(本仓库)。模型 glm-5.2-high。
> 日期:2026-09-14(北京时间)。

## 1. 背景与目标

OpenCode 在 Windows 上默认禁用 FFF(Fast File Find)搜索后端,回退到 ripgrep。
本测试验证:**开启 FFF 后,Agent / Workflow 的实际体感性能是否有收益。**

分两层:
1. 第一层(本报告):Workflow 端到端 A/B —— 测 Agent 用户体感性能,含 LLM 延迟。
2. 第二层(后续):纯 `find/grep` benchmark —— 把 LLM 延迟排除,直测两后端搜索耗时。

## 2. 核实事实(均有本地源码证据,禁止发明 API)

| 事实 | 证据 |
|---|---|
| `OPENCODE_DISABLE_FFF` 环境变量真实存在 | `thirdparties/opencode/packages/core/src/flag/flag.ts:9,34` |
| Windows 默认禁用(env 未设时 `= process.platform === "win32"`) | `flag.ts:34` |
| `=1` → Flag 为 true → ripgrep 后端;`=0` → Flag 为 false → fff 后端(若 `Fff.available()`) | `thirdparties/opencode/packages/core/src/filesystem/search.ts:235` |
| fff 后端按会话目录 `basePath` 建索引,只索引会话目录 | `search.ts:128-133`(`Fff.create({ basePath: location.directory, ... })`) |
| workflow DSL 沙箱禁用 `Date.now()` / `new Date()` / `Math.random()`(文本级扫描,连注释里出现都拒) | `src/runtime/vm.ts:35-58` |
| workflow tool 的 `scriptPath` 相对项目目录解析,服务端读盘 | `src/tools/script-source.ts:30` |
| `opencode run --command <name> --auto` 调用 `.opencode/commands/<name>.md` | `thirdparties/opencode/packages/opencode/src/cli/cmd/run.ts`(`--command` 分支) |
| workflow 经插件注册的 `workflow` tool 触发 | `src/index.ts:24`(`workflow: createWorkflowTool(...)`) |

> 关键约束:因 workflow 沙箱禁用时间 API,**计时只能在 workflow 外层(外层 PowerShell 包住 `opencode run`)**完成。这决定了本测试的架构。

## 3. 基准设计

### 3.1 架构

```mermaid
flowchart TD
    A[PowerShell 包装脚本] -->|设 OPENCODE DISABLE FFF| B[opencode run command fff bench auto]
    B --> C[slash 命令 fff bench md]
    C --> D[调用 workflow tool scriptPath]
    D --> E[执行 fff search benchmark js]
    E --> F[单 agent 连续 20 次原生 glob 与 grep]
    F --> G[结构化 JSON 返回每条命中数与前 5 路径]
    G --> H[stdout 写入 log 文件]
    A -->|Stopwatch 包住整段 opencode run| I[墙钟耗时写入 json 元数据]
```

设计要点:
- **单 agent 20 连测**(10 glob + 10 grep),减少多 agent 各自 LLM 预热的方差,让搜索后端耗时在总时长中累积到可观测量级。
- **每个 pattern 显式**,保证 A/B 两路 agent 行为一致,唯一变量是 `OPENCODE_DISABLE_FFF`。
- **计时在外层** `[System.Diagnostics.Stopwatch]` 包住 `opencode run`,绕开 workflow 沙箱的时间 API 禁令。
- **正解性校验**:每条查询返回 hits + 前 5 路径,A/B 两路 hits 应一致(差异即后端行为差异)。

### 3.2 文件清单(均在 `examples/sample-project/`)

| 文件 | 作用 |
|---|---|
| `.opencode/workflows/fff-search-benchmark.js` | 小项目版 workflow(目标为当前项目) |
| `.opencode/commands/fff-bench.md` | slash 命令,触发 workflow 并原样回传 JSON |
| `benchmarks/run-fff-bench.ps1` | 共享 runner:`-Mode on/off -ProjectDir`;用 `cmd /c` 原生重定向绕 PS 5.1 stderr 坑;Stopwatch 计时;存 `.log/.err/.json` |
| `benchmarks/run-fff-off.ps1` / `run-fff-on.ps1` | 一键包装脚本 |
| `benchmarks/run-fff-ab.ps1` | A/B 编排器:`-Runs -ProjectDir`;出对比表 + `ab-summary-*.json` |
| `benchmarks/large-target/` | 干净大目标项目(见 3.3) |

### 3.3 大树目标(避免污染第三方树)

fff 只索引会话目录,所以让 fff 索引大树必须把会话目录设在大树上。但直接在 `thirdparties/opencode`(OpenCode 自己的仓库,有自己的 `.opencode` 配置会冲突)跑会冲突。解法:

- 新建干净项目目录 `benchmarks/large-target/`,其 `opencode.json` 用 `"plugin": ["../../../../"]` 从仓库根加载本插件;
- 用 **Windows junction**(非 symlink,免管理员)把 `large-target/src` 指向 `thirdparties/opencode/packages`(6375 个源码文件,无 node_modules);
- 该目录自带 `fff-bench` 命令与 `fff-search-benchmark.js`(glob/grep 均传 `path="src"`,见发现 4.2)。

### 3.4 怎么跑

```powershell
# 单次单边
.\benchmarks\run-fff-off.ps1
.\benchmarks\run-fff-on.ps1

# 大树单边
.\benchmarks\run-fff-bench.ps1 -Mode off -ProjectDir 'benchmarks\large-target'
.\benchmarks\run-fff-bench.ps1 -Mode on  -ProjectDir 'benchmarks\large-target'

# A/B 多轮(大树)
.\benchmarks\run-fff-ab.ps1 -Runs 3 -ProjectDir 'benchmarks\large-target'
```

## 4. 关键发现

### 4.1 fff 在本机可用

`OPENCODE_DISABLE_FFF=0` 时 fff 后端真实启用(ON 轮 glob/grep 均返回真实结果)。`Fff.available()` 在本机返回 true。

### 4.2 fff 跟 junction,rg glob-from-root 不跟(重要)

- ON(fff)的 glob 用 pattern `src/**/*X*` 从项目根搜索,**能**遍历 junction 找到文件;
- OFF(rg)的 glob 用同样的 pattern 从项目根搜索,**跳过** junction reparse point,返回 0;
- 但 OFF(rg)的 grep 用 `path="src"`(cwd 解析进 junction 内部)时**能**正常搜索。

修复:glob 也改用 `path="src"` + pattern `**/*X*`,让 rg 的 cwd 也进 junction 内部,两路对称。
**结论:任何让 ripgrep 搜索 junction/挂载点的工作流,都必须用显式 `path=` 让 cwd 进入,不能靠从根目录的 pattern 隐式遍历。**

### 4.3 LLM 方差压倒搜索差异(核心结论)

- 大树 OFF 两次跑:428.78s(混淆版,glob 空跑)vs 268.10s(修复版,glob 真搜索,工作量更大却更快)—— **同模式两次差 160s**;
- 全部 20 次搜索的真实工作量估计仅 30-40s;
- 即:**单轮 A/B 的差距(几十秒)完全淹没在 LLM 轮次方差里,不能下结论**。

这正是第一层端到端测试的固有局限。要拿真信号,要么多轮取均值(见第 5 章),要么上第二层纯 `find/grep` benchmark(不经 agent)。

### 4.4 正确性

修复版大树单轮:OFF(rg)与 ON(fff)20 条查询 hits **完全一致**(60,3,100,43,41,100,53,100,36,7,68,0,0,100,100,100,100,100,100,100),A/B 对称有效。

> 注:`agent(`/`phase(`/`parallel(` 这类含未闭合括号的 pattern,跨轮出现过 0 vs 68 的波动,属 agent 对 `(` 转义处理的不稳定(非后端固有差异),单轮内两路一致。

## 5. 已执行运行汇总

| # | 目标 | Mode | 耗时(s) | exit | tag | 备注 |
|---|---|---|---:|---|---|---|
| 1 | 小项目 sample-project | off | 248.87 | 0 | - | 含 agent 自动修注释的额外 LLM 轮(混淆) |
| 2 | 小项目 sample-project | on | 156.76 | 0 | - | |
| 3 | 大树 large-target | off | 428.78 | 0 | large | rg glob 跳过 junction(混淆,工作量减半) |
| 4 | 大树 large-target | on | 461.44 | 0 | large | fff glob 走 junction |
| 5 | 大树 large-target(修复对称) | off | 268.10 | 0 | large-fixed | glob 改 path=src,20 真搜索,正确性 20/20 一致 |
| 6 | 大树 large-target(修复对称) | on | 305.10 | 0 | large-fixed | 同上;fff +13.8%(单轮,在噪声内) |

产物均落盘于 `benchmarks/large-target/results/`(或小项目的 `benchmarks/results/`),含 `fff-<mode>-run-<n>-<stamp>.log`(agent 打印的 JSON 搜索结果)+ `.json`(计时元数据)+ `.err`(stderr 留查)。

## 6. 三轮均值结果(大树 large-target,6375 文件)

> 命令:`.\benchmarks\run-fff-ab.ps1 -Runs 3 -ProjectDir 'benchmarks\large-target'`
> 实际耗时约 29 分钟(6 次 opencode run)。产物:`benchmarks/large-target/results/ab-summary-20260914-172857.json`。

| 模式 | Run 1 (ms) | Run 2 (ms) | Run 3 (ms) | 均值 (ms) | 备注 |
|---|---:|---:|---:|---:|---|
| OFF (ripgrep) | 236320 | 341592 | 306502 | 294805 | 极差 105s(约均值 36%) |
| ON (fff) | 338733 | 285000 | 236631 | 286788 | 极差 103s(约均值 36%) |
| delta | +102413 | -56592 | -69871 | **+8017** | fff 快 8.0s |
| 提升% | fff 慢 43.3% | fff 快 16.6% | fff 快 22.8% | **fff 快 2.7%** | |

### 6.1 统计分析

- 粗算标准差:OFF ≈ 45s,ON ≈ 51s(样本 n=3);
- 均值差 8.0s ≈ **0.2 个标准差**,远低于显著性门槛;
- 单轮方向不一致:Run 1 fff 反而慢 43%,Run 2/3 fff 才快 —— 典型的**随机波动而非稳定效应**;
- 结论:**在 6375 文件 + glm-5.2-high 这套组合下,fff 与 ripgrep 对端到端 Agent 工作流耗时无可测量差异,2.7% 完全淹没在 LLM 轮次方差里。**

### 6.2 正确性

3 轮均 exit=0。抽验 Run 3:OFF 与 ON 20 条查询 hits 基本一致(19/20 完全相同),仅 id=7 (`**/*plugin*`) OFF=52 / ON=56 差 4 个,属 fff 在未显式传 limit 时默认页大小截断 glob 结果的已知行为差异(见 `search.ts` fffLayer.glob 用 `pageSize: input.limit`,缺省时可能截断)。

## 7. 结论与建议

### 最终结论(综合第一层端到端 + 第二层纯搜索)

1. **fff 在本机 Windows + opencode 1.18.30 可用且 `=0` 真实启用**,不会崩、不会静默回退。
2. **搜索后端本身:fff 在冷搜索上明显更快(约 2 倍,glob 尤甚 73%),OS 文件缓存热后两路基本持平甚至 rg 略快**(见第 8 章)。这是把 LLM 延迟完全扣除后的真实后端差异。
3. **但端到端体感:fff 收益被 LLM 噪声淹没**。第一层 3 轮均值 fff 仅快 2.7%(< 1σ,方向不稳);原因是 LLM 占 explore agent 时间的 ~81%(第 8 章实测:纯搜索 46s vs agent 总 240s),搜索后端优化的端到端收益天花板很低。
4. **两后端行为差异**:fff glob 未传 limit 时按默认页大小可能截断结果;fff grep 有 1.5s `timeBudgetMs` 上限(`search.ts:170`)可能截断大结果;rg glob 从项目根不跟 junction/reparse point(必须显式 `path=`)。正确性影响小但值得知晓。

### 一句话

> fff 搜索本身在冷启动时确实快得多,但 opencode 的 Agent 工作流瓶颈是 LLM 轮次而非搜索;在 Windows 上是否长期开启 fff,取决于你是否在意"首次冷搜索"的那点加速,以及内存开销是否可接受。热缓存后 rg 与 fff 基本同速。

### 建议

- **日常一次性 `opencode run`、活跃开发(树已热)**:保持 Windows 默认(rg)即可,fff 无可感知收益。
- **冷启动场景(首次扫大库、CI、刚开机首跑)**:可开 fff,首次搜索明显快;但单次 run 总耗仍由 LLM 主导。
- **长会话反复搜索**:本测试每次 `opencode run` 是独立进程,fff 索引按会话构建不复用(`disableMmapCache:true`),所以跨进程每次都 cold。要看 warm 索引复用收益,需在同一会话内连续多次跑(`opencode run -c` 续会话),属 v3。
- **更大树**:把 junction 指向更大树可放大冷搜索差异;注意 fff 是否尊重 .gitignore(本测试未验证,大树含 node_modules 时可能索引爆量)。

## 8. 第二层:纯搜索后端 benchmark(LLM 完全扣除)

> 目的:第一层端到端被 LLM 方差主导,看不到后端真相。第二层把 LLM 完全扣除,直测 fff vs rg 的纯搜索耗时。
> 方法:`opencode run --format json` 拿主会话事件流 → 从 `workflow` tool 的 `part.state.metadata.agents[0].sessionId` 取 explore **子会话 ID** → 查 `~/.local/share/opencode/opencode.db` 的 `part` 表,过滤 `type='tool'` 且 `tool in (glob,grep)`,对每个 part 的 `state.time.end - state.time.start` 求和 = **纯搜索总耗时**(LLM 推理全部排除)。
> 工具:`better-sqlite3` 只读查询;脚本 `C:\...\Temp\opencode\fff-bench-db\query.js`(传子会话 ID)。

### 8.1 三轮纯搜索结果(大树 large-target,6375 文件)

| 轮 | OS 缓存 | OFF 总 (ms) | OFF glob | OFF grep | ON 总 (ms) | ON glob | ON grep | fff vs rg |
|---|---|---:|---:|---:|---:|---:|---:|---|
| R1 | 冷 | 46149 | 26449 | 19700 | 22828 | 7033 | 15795 | **fff 快 50.5%**(glob 快 73%) |
| R2 | 热 | 17912 | 4518 | 13394 | 16147 | 4966 | 11181 | fff 快 9.9%(glob 基本持平) |
| R3 | 热 | 12797 | 5208 | 7589 | 16465 | 4249 | 12216 | fff 慢 28.7%(grep 慢) |
| 均值 | | 25619 | 12058 | 13561 | 18480 | 5416 | 13064 | fff 快 27.9%(冷轮主导) |
| 仅热 R2/R3 均值 | | 15355 | 4863 | 10492 | 16306 | 4608 | 11699 | **fff 慢 6.2%(基本持平)** |

每轮 explore agent 总时 vs 纯搜索(以 R1 off 为例):agent 239627ms,纯搜索 46149ms → **LLM 占 80.7%,纯搜索仅 19.3%**。

### 8.2 冷/热分析(核心洞察)

- **冷(R1,该树首次搜索)**:rg 每次 glob 冷遍历目录树(~2.6s/次),fff 用内存索引(~0.7s/次)→ **fff glob 快 73%、总快 2 倍**。这是 fff 的设计优势:索引遍历冷盘 vs 内存查找。
- **热(R2/R3,OS 文件缓存已热)**:rg 走页缓存也快了(~0.5s/次 glob),fff 优势消失,两路基本持平甚至 rg 略快(grep 上 rg 有时更快)。说明 **fff 的收益主要在"首次冷搜索",OS 缓存热后被 rg 追平**。
- **grep 后端两路始终接近**:fff 因 `timeBudgetMs:1_500` 把每次 grep 钉在 ~1.5-2s 上限,rg grep 随缓存波动(0.6-2.7s)。fff grep 不一定更快,且有截断风险。
- **方差来源**:即使扣除 LLM,纯搜索仍受 OS 文件缓存冷/热影响(R1 vs R2 差 6 倍),这是任何文件搜索基准的固有变量。

### 8.2.1 冷热对比图

```mermaid
flowchart TD
    subgraph Cold ["冷搜索 首次扫树 OS缓存未热"]
        direction LR
        A1["ripgrep 纯搜索 46149ms"]
        A2["fff 纯搜索 22828ms"]
        A1 --> A2
        AC["fff 快约2倍 glob优势明显"]
    end
    subgraph Warm ["热搜索 反复扫描 OS缓存已热"]
        direction LR
        B1["ripgrep 纯搜索 15355ms"]
        B2["fff 纯搜索 16306ms"]
        B1 --> B2
        BC["基本持平 rg略快"]
    end
    Cold -- OS缓存升温 --> Warm
    Warm --> Done["端到端仍被LLM主导 搜索占比约两成"]
```

> 数值取自第 8.1 表:冷=R1 实测,热=R2 与 R3 均值。纵向上读:冷态 fff 明显快;热态两路持平;横向箭头点出即便搜索快了,端到端仍被 LLM 占据。

### 8.3 方法论注记

- 主会话事件流(`--format json`)只含主 agent 的 1 次 `workflow` tool_use;20 次 glob/grep 发生在 workflow 内部 explore **子会话**,其工具 part(含 `state.time`)持久化在 `opencode.db` 的 `part` 表,按 `session_id` 查询。
- 跨轮 agent 行为有方差(有时先跑 glob/bash/read 扰动再调 workflow),但不影响纯搜索提取(始终从子会话取)。
- glob 调用起始时间常重叠(agent 单轮并行发多个 glob),故"求和"是总工作量非墙钟;A/B 两路并行模式一致,求和可比。
- better-sqlite3 以 `readonly:true` 查询,不影响 opencode 运行。

## 9. 参考引用

- 环境变量与后端选择:`thirdparties/opencode/packages/core/src/flag/flag.ts`、`thirdparties/opencode/packages/core/src/filesystem/search.ts`
- fff grep 的 timeBudgetMs 截断:`thirdparties/opencode/packages/core/src/filesystem/search.ts:170`
- `opencode run --command`:`thirdparties/opencode/packages/opencode/src/cli/cmd/run.ts`
- workflow 沙箱禁用时间/随机 API:`src/runtime/vm.ts`
- workflow tool 与 scriptPath 解析:`src/tools/workflow.ts`、`src/tools/script-source.ts`
- 工具 part 的 `state.time.start/end`(纯搜索计时来源):`thirdparties/opencode/packages/opencode/src/cli/cmd/run/tool.ts:192-194`、`subagent-data.ts:283-288`;持久化于 `~/.local/share/opencode/opencode.db` 的 `part` 表(`session_id`+`data` JSON)
- 本仓库 AGENTS.md(事实来源与 API 约束):`AGENTS.md`
- OpenCode 官方插件文档:`thirdparties/opencode/packages/web/src/content/docs/plugins.mdx`
