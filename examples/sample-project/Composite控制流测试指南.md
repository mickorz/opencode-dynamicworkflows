# Composite 控制流 V1（sequence / fallback）手动测试指南

> 验收 P0 交付：`sequence()` / `fallback()` 组合节点与 child 失败中止面修正（分支 feat/composite-control-flow，commit 99c3c38..eeedf67）。
> 前置：仓库根已 `npm run build` 且 **OpenCode 已重启**（插件进程缓存旧 dist 会不识别新 globals，报 `sequence is not defined`）。
> 本目录已内置全部验收脚本（`scripts/composite/`），按下列 Test 逐项执行。
> 对应需求：`Docs/01_需求与规划/Composite控制流开发计划V1.md` 的 P0 部分。

## 本轮验收要回答的三个问题

1. sequence / fallback 在真实 LLM 会话里是否按三态规则工作（success / failure / cancelled / 结构性上抛）
2. journal / resume 对 sequence 是否透明（key 不漂移、回放不漏）
3. child 脚本 throw 不再污染整 run 中止面（fallback 换候选、parallel 塌缩 null、父 try-catch 可续行）

```mermaid
flowchart TD
    A[仓库根构建] --> B[本目录重启 OpenCode]
    B --> C[Test1 sequence 三段串行]
    C --> D[Test2 组合 parallel]
    D --> E[Test3 失败终止]
    E --> F[Test4 与 Test5 fallback]
    F --> G[Test6 结构性错误]
    G --> H[Test7 parallel 塌缩]
    H --> I[Test8 resume 回放]
    I --> J[填写验收记录表]
```

---

## Test 1：sequence 三段串行（与旧写法实机对照）

```
读取 scripts/composite/seq_parent.js 的内容，用 workflow 工具原样执行（scriptPath 传 scripts/composite/seq_parent.js，前台执行），把返回 JSON 结果字段原样贴出
```

**通过标准**：
- 返回含 `lastNodeValue.code`（伪代码文本）与 `chain` 字段——三个 child 的结果经 prev 链传递：`1_spec.js` 的返回整体作为第二个节点的入参，节点内取 `spec.brief` 下发
- 与 `scripts/native/pipeline_parent.js`（旧 await 链写法）结果语义等价：两者都产出 brief/design/code 链
- 父脚本零 agent（纯编排），全程仅 3 次 LLM 调用
- `.opencode-workflows/journal/` 新增**一个** run 文件，3 条 entry 的 key 形如 `run-xxx:wf0:0`、`run-xxx:wf1:0`、`run-xxx:wf2:0`——**sequence 自身不产生额外 journal 记录**（这是 journal 透明的核心判定）
- TUI 会话树仍显示 `▸ native_spec / 需求概述` 等三组（sequence 不改变 observability 结构）

## Test 2：sequence 节点内组合 parallel

```
用 workflow 工具前台执行 scripts/composite/seq_parallel_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- 返回 `laneCount: 2`，`briefs` 两项各含"视角编号 视角种子-A / 视角种子-B"——parallel 节点收到 sequence 传入的 prev（`'视角种子'` 字符串），两实例按 tag 隔离
- 两条 brief 内容顺序与声明顺序一致（parallel 保序）

## Test 3：sequence 可恢复失败立即停止

```
用 workflow 工具前台执行 scripts/composite/seq_fail_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- `seqResult: null` 且 `isNull: true`——第二个节点 throw 后序列停止，**不是**抛错杀 run
- `seen: ["a", "b"]`——第三个节点未执行
- `after: "STOP-CHECK"`——sequence 返回 null 后父脚本照常继续（与 `agent()` 可恢复失败返回 null 的语义对齐）
- run 日志含 `sequence[1] 失败，序列停止` 字样

## Test 4：fallback 首个候选成功即返回

```
用 workflow 工具前台执行 scripts/composite/fb_first_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- `winner: "fast"`——纯 JS 候选直接成功
- 全程零 LLM 调用也能正常完成（本脚本无 agent；纯 JS fallback 是合法纯编排）
- journal 无新增 entry（没有 agent 调用）

## Test 5：fallback 候选为 child workflow，失败换下一候选（poisoning 修正核心）

```
用 workflow 工具前台执行 scripts/composite/fb_child_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- `winner.brief` 是 `1_spec.js`（tag 为 FALLBACK 视角）的产出——第一个候选 `error_child.js` 脚本 throw 后，**第二个候选照常执行并胜出**
- `after: "AFTER-FALLBACK"`——fallback 结束后父脚本继续，run 没有被 child 失败污染成 aborted
- run 日志含 `workflow("error_child") 失败` 与 `fallback[0] 失败，尝试下一候选`
- 对照（可选）：在 v0.9.0 旧版本上跑同脚本会直接整 run 失败——这就是本次修正的实机差异

## Test 6：结构性错误必须上抛（fallback 不吞编程错误）

```
用 workflow 工具前台执行 scripts/composite/fb_structural_parent.js，贴出报错原文
```

**通过标准**：
- workflow 工具**失败**，报错含 `不存在或不可读`——拼错的子脚本名是结构性错误，不允许被 fallback 伪装成"降级到 backup 候选"
- 返回 JSON 中**没有** `winner: "backup"`（第二个候选从未执行）

## Test 7：parallel 内 child 失败塌缩为 null（行为修正确认）

```
用 workflow 工具前台执行 scripts/composite/par_child_fail_parent.js，把返回 JSON 原样贴出
```

**通过标准**：
- `len: 2`、`failedLane: "collapsed-null"`——`error_child.js` 的槽位是 null 而非杀 run
- `okLane` 含 SIBLING 视角的 brief——兄弟分支不受失败分支影响
- 对照：v0.9.0 上此脚本整 run 失败（child throw 污染 `shared.aborted`，parallel 的塌缩逻辑被短路）

## Test 8：resume 下 sequence 内 agent 全量回放

1. 前台执行 `scripts/composite/seq_resume_parent.js`，记下返回 JSON 里的 `runId`
2. 让 Main Agent 修改脚本：把 `PARENT-PROBE` 改成 `PARENT-PROBE-2`（只动 sequence 之外的父 agent）
3. 续跑：`resumeFromRunId=<刚才的 runId>` + 修改后的脚本（先改文件再续跑）

**通过标准**：
- 父的 agent 重跑（结果含 `PARENT-PROBE-2`）
- sequence 内两个 agent **从 journal 回放**：`SEQ-NODE-1` 原文不变，第二个 agent 的返回仍是首跑的复述文本（回放结果作为 prev 链路不变）
- 本次 run 的 token 消耗只有父那一次 agent 的量级
- journal 中 entry 的 key 为 `runId:0`、`runId:1`、`runId:2` 连续编号——sequence 不占 callIndex（若出现 `runId:4` 之类的漂移即失败）

---

## 排查清单

| 症状 | 原因 | 处置 |
|------|------|------|
| `sequence is not defined` | OpenCode 进程缓存旧 dist | 退出 OpenCode 后在本目录重新启动 |
| Test 5 整 run 失败 | 插件未加载新构建（poisoning 修正未生效） | 仓库根 `npm run build` 后重启 |
| Test 8 回放不命中 | 脚本修改触发了 journal miss（预期行为是父 agent 重跑） | 确认只改了 PARENT-PROBE 字样，未动 sequence 内 prompt |
| Test 6 返回了 winner | fallback 吞了结构性错误 | 记录为缺陷（违反三态契约） |
| TUI 树缺 child 分组 | observability 回归 | 记录为缺陷 |

## 验收记录表

| Test | 结果 | 备注 |
|------|------|------|
| 1 sequence 三段串行 | [ ] | |
| 2 组合 parallel | [ ] | |
| 3 失败终止返回 null | [ ] | |
| 4 fallback 首选成功 | [ ] | |
| 5 fallback child 换候选 | [ ] | poisoning 修正核心 |
| 6 结构性错误上抛 | [ ] | |
| 7 parallel 塌缩 null | [ ] | 行为修正确认 |
| 8 resume 全量回放 | [ ] | journal 透明核心 |

全部通过后，P0 实机验收完成，可进入 P1（race / Local Abort Scope / Pipeline A/B）。
