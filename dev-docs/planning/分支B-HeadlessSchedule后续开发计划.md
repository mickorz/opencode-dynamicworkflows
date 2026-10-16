# 后续开发计划：分支 B——Schedule Headless 执行模式（Backlog，暂不执行）

> 状态：**Backlog**。等真实需求出现再启动，当前明确不排期。
> 来源：《后续需求P1.5-P2执行计划.md》v2 §4（设计已定稿，本文档为启动时的执行依据）。
> 记录时间：2026-09-18（v0.9.0 发布后）。

## 1. 启动条件（什么算"真实需求出现"）

满足任一即重新评估排期：

1. 用户实际工作流中需要**OpenCode 关闭期间**到点执行（如夜间无人值守批处理、服务器场景）
2. 机器重启后任务仍需自动生效（attached 依赖 TUI 常开）
3. 出现"不想为定时任务保持 OpenCode 常驻"的明确成本/资源诉求

仅是"觉得应该有"不算——P1 的 attached 模式已覆盖"工作期间 OpenCode 本来就开着"的主场景。

## 2. 目标与边界

> schedule 可选 `executionMode: "attached"（现状，进程内）| "headless"（OS 定时器拉起独立 runner，OpenCode 无需运行）`

原系统级方案（v1 计划）的核心链路回归：schtasks → CLI runner → spawn opencode serve → SDK client → OpenCodeSessionAdapter → runWorkflow。**当年砍掉的风险（serve 无头可用性）原样存在，是本项的闸门。**

### executionMode 路由语义（定案，开发时不得偏离）

```text
executionMode = "attached"（默认）
  → 仅 In-Process Scheduler 负责该 schedule；OS 侧无任务

executionMode = "headless"
  → In-Process Scheduler 的 tick 忽略该 schedule；仅 OS Scheduler 负责
```

> **claim 不是 routing 机制**。claim 仅作最后幂等保护（手工 run_now 与到点重叠等异常场景）；双模式随机争抢会造成执行环境不稳定，产品行为不可接受。

## 3. 复用盘点（P1 期间已白拿，启动时零重做）

| v1 方案组件 | 现状 |
|-------------|------|
| 跨进程 claim（原子 wx + epoch 文件名） | ✅ 现成（attached 本就跨进程安全） |
| 磁盘 execution lock + pid 僵尸检测 | ✅ 现成 |
| Run Record / journal / TUI 快照 | ✅ 现成 |
| fresh session + 不回传 + Record 落盘 | ✅ 现成 |
| Schedule 领域层 / 8 个工具面 | ✅ 加 executionMode 字段即可 |
| workflow-registry（按名寻址脚本） | ✅ v0.10 现成 |

## 4. 任务分解（约 4-5 天，启动时执行）

| # | 任务 | 说明 |
|---|------|------|
| 0 | **Spike（0.5 天，闸门）**：spawn `opencode serve`（随机端口）+ `createOpencodeClient` + 一条 prompt 全链路；验证认证继承与启动耗时 | 不通过则继续 Backlog，attached 模式不动 |
| 1 | `Schedule.executionMode` 字段 + schedule_create/update 参数 + **tick 路由**（headless 被忽略） | 默认 attached 零破坏 |
| 2 | headless runner CLI（内部命令 `schedule-exec --schedule-id`）：读配置 -> claim/lock（复用）-> spawn serve -> 复用 OpenCodeSessionAdapter 执行 -> Record 终态 -> kill serve | 注册时固化 node 绝对路径（Task Scheduler 环境不依赖 PATH） |
| 3 | Windows schtasks Adapter：cron 四模式映射（DAILY/WEEKLY/MINUTE/HOURLY）、命令行固化、enable/disable/delete/exists | 跨平台跳过标记（systemd/launchd 后续） |
| 4 | 执行语义：timeout / checkpoint 即败与 attached 共用 runtime 注入面 | 现成 confirm 抛错逻辑 |
| 5 | 工具面：create/update 回显双模式提示（headless 不显示 Requires OpenCode running）；schedule_get 显示 osJobExists | |
| 6 | 测试 + 实机：关 OpenCode 后到点执行、重启电脑任务保留、attached/headless 各自路由正确（互不争抢）、混跑同 slot 恰一次 | 原 v1 Test 2/3 回归 |

## 5. 风险（未消除部分，与 v1 计划一致）

| 风险 | 等级 | 对策 |
|------|------|------|
| serve 无头可用性（认证/稳定性/耗时） | 高 | Spike 前置闸门；失败兜底 `opencode run` 一次性命令（token 成本更高） |
| schtasks 环境差异（API key / PATH） | 中 | 注册时固化绝对路径；Spike 顺带实测 |
| 企业策略限制 schtasks | 低 | doctor 检测 + 报错给自提权指引 |
| Bun CJS interop（serve/SDK 若为 CJS） | 中 | 具名导入铁律（见 Docs/05_问题与注意事项/Bun-CJS-interop 与 meta 命名） |
| 复杂度回归 | 中 | 严格按复用盘点只做缺口；不重构已验证的 P1 层 |

## 6. 验收标准（启动时）

- `executionMode: headless` 的每日任务在 **OpenCode 关闭状态**下到点执行成功，Record/journal 与 attached 同构
- 重启电脑后 schtasks 任务保留、继续触发
- attached TUI 开着 + headless 到点：各自路由、同 slot 恰一次（claim 幂等兜底）

## 7. 引用

- 设计定稿：《后续需求P1.5-P2执行计划.md》v2 §4
- v1 系统级方案（被砍的完整形态）：《Schedule功能P1执行计划.md》
- SDK 事实：`thirdparties/opencode/packages/sdk/js/src/client.ts`（createOpencodeClient）
- 现有实现：`src/schedule/*`（claim/lock/Record/runtime）、`src/runtime/workflow-registry.ts`
- 相关坑档：`Docs/05_问题与注意事项/Bun-CJS-interop与meta命名-Schedule验收踩坑.md`
