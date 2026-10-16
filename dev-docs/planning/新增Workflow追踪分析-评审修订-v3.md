# 新增 Workflow 追踪分析 - 评审修订 v3

> 本文件基于第三轮评审（对 P4 执行文档 v2 的评审）整合修订，核实其全部源码声明并记录处置。
> v3 不推翻 P4 v2 的架构与阶段划分，只补齐 4 个 P0 契约与 3 项 P4-0 约定，修订直接落入 v2 文档对应章节。
>
> 评审基线：P4 执行文档 v2；源码核实基于本仓库当前工作区（Composite V1 之后）。

## 类头流程图：第三轮评审后的审批与应用链路

```
 评审后修正的应用链路（审批与应用解耦）

 业务 Run 积累 P3 Proposal
        |
        v
 P4 聚合（候选指纹跨 Run 共享）
        |
        v
 按 Workflow 溯源定位 Patch 目标（manifest workflowSource 契约）
        |
        v
 worktree 隔离 A B（宿主 ABExecutor 执行）
        |
        v
 ABEvaluator 宿主评估（产物对比 哈希 指标预计算）
        |
        v
 三道闸门（DSL check 消费预计算结果）
        |
        v
 checkpoint 人工确认（headless abort）
        |
        +-- 拒绝 --> rejected 保留原版
        |
        +-- 批准 --> 宿主持久化 ApprovalRecord（可信批准记录）
                        |
                        v
                 OptimizationJob 状态机驱动宿主 applyCandidate
                 多文件事务（预检查 暂存 备份 部署 验证 恢复）
                        |
                        v
                 applied 落台账（记录经验由宿主单独发起）
```

## 一、总体结论

第三轮评审提出 4 个 P0 问题与 3 项契约补充，经仓库源码逐一核实，全部成立：

| 编号 | 问题 | 核实结论 | 处置（落点） |
|------|------|----------|------|
| P0-1 | 原 Workflow 源码定位无真实数据来源 | 成立：`TraceManifest` 无脚本路径/哈希字段（`src/trace/types.ts:12-33`）；`run-finalizer.ts` 不落盘顶层脚本来源；`AnalysisToolEvent` 是 Agent Session 工具事件，不保证包含顶层 workflow 工具调用参数；`workflow.ts` 虽接收 `scriptPath`/内联 `script`，均未溯源落盘 | 新增 WorkflowSource 溯源契约，RunFinalizer 写入 manifest；仅 `kind: "file"` 且哈希校验通过者可自动 Patch；聚合候选可共享，Patch 按目标 Workflow 分开生成（v2 文档 4.0.1、4.1） |
| P0-2 | A/B 示例 `fs.readFile()` 在 DSL 中不可用 | 成立：VM 沙箱无 fs/child_process，runtime 仅注入 check/fileExists/commandSuccess 等（`workflow-runtime.ts:879` 注释）；`verify()` 分母为实际返回票数（line 1128-1131），reviewer 失败后 1/1 >= 2/3 单票即过 | 新增 ABExecutor / ABEvaluator 宿主契约，check() 只消费预计算结果（4.3.5）；verify 补 realCount 绝对数双重校验（4.3.4） |
| P0-3 | 两个 worktree 不等于候选执行已获强隔离 | 成立：`src/isolation/worktree.ts` 只负责创建/删除；`workflow-runtime.ts:494-507` 的 Agent 目录约束靠提示词拼接，非强制；`isolated === true` 仅代表 git 工作树隔离 | 新增 executeInWorktree 宿主执行契约与能力边界表（4.3.2）；无法保证目录约束时 P4-C 降格为受信任代码隔离测试；worktree 生命周期 try/finally |
| P0-4 | P4-D 未真正接上确定性应用代码 | 成立：DSL 无调用宿主 TypeScript 函数的通道，agent() 凭提示词无法可靠执行 applyCandidate()；applyCandidate 只比对调用方传入哈希，不能证明批准真实发生；候选含 Workflow Patch + 固化工具双文件，单文件 rename 不等于应用成功 | 确认脚本只产出批准凭证；新增 ApprovalRecord 持久化批准记录；应用改为宿主驱动的 Candidate Bundle 多文件事务（4.3.6、4.3.7） |

## 二、三项 P4-0 契约补充

| 问题 | v2 原方案 | v3 修订（落点） |
|------|----------|--------|
| 目标 Agent 节点定位 | `phase + label` | 源码位置 + 节点调用序 + originalScriptHash 三方绑定；重名/歧义禁止自动 Patch，转人工（4.2.1、4.2.3） |
| 防递归标记 | 候选脚本 meta 自声明 `developmentForbidden` | 由 Runtime 启动参数强制传入（验证执行不带 development），不依赖脚本 meta 自动生效（设计约束 3、4.2.3） |
| 纯确定性节点 | 强制保留至少一个 Agent/Checkpoint | 保留为 P4 MVP 临时约束并显式声明；不得为满足 Runtime 保留无意义 Agent；长期方向为可执行确定性脚本并返回结构化输出的原生确定性节点（4.0.2） |

## 三、追加验收用例

| 验收项 | 期望结果 |
|--------|---------|
| 两个 Run 来源于不同 Workflow JS | 聚合机会可共享，但不能错误修改另一个 Workflow |
| Workflow 使用内联 `script` | 可以分析，不允许未经源码落盘就自动应用 |
| A/B 的 Agent 写入原项目路径 | 隔离验证失败，不进入审批 |
| 三名 Reviewer 仅一名返回赞成 | 不通过 2/3 质量闸门（realCount 绝对数校验） |
| 用户拒绝或没有人工确认通道 | 不调用 `applyCandidate`，原文件完全不变 |
| Workflow JS 应用成功但固化工具部署失败 | 整体失败，恢复原始文件状态 |

## 四、最终决定

- P4 v2 有条件通过设计评审：批准 P4-0 与 P4-A 开发
- P4-B 先用真实 P3 样本（`p3-analyzer-verify.js` + `p3_validate.py`）做手动原型，原型通过后再写自动生成器
- P4-C / P4-D 在四类契约（WorkflowSource / ABExecutor+ABEvaluator / ApprovalRecord / Candidate Bundle Apply）落地后实施
- 不新增大阶段，全部修订落入 v2 文档对应章节

## 五、引用说明

- P4 执行文档 v2（本轮评审对象与修订落点）：`dev-docs/planning/新增Workflow追踪分析-P4执行文档-v2.md`
- 前两轮评审记录：`dev-docs/planning/新增Workflow追踪分析-评审修订-v1.md`、`-v2.md`
- TraceManifest 字段（P0-1 核实）：`src/trace/types.ts:12-33`
- VM 沙箱注入全局（P0-2 核实）：`src/runtime/workflow-runtime.ts:879`
- verify 分母实现（P0-2 核实）：`src/runtime/workflow-runtime.ts:1128-1131`
- Agent worktree 提示词路由（P0-3 核实）：`src/runtime/workflow-runtime.ts:494-507`
- worktree 创建/删除（P0-3 核实）：`src/isolation/worktree.ts`
