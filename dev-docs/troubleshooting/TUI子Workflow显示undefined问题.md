# TUI 子 Workflow phase 显示 undefined 问题

> 发现时间：2026-10-14，Composite 身份冲突联调验证时发现
> 严重度：低（展示面问题，不影响执行逻辑）
> 状态：已修复

## 现象

TUI 侧边栏子 Workflow 节点行显示 `▸ child_seq / undefined`，其中 `undefined` 是字符串字面值，不是缺省省略。

```
composite_verify / child_seq
[Sequence]
▸ child_seq / undefined · 1m09s      <- 这里
● agent 1 ·23.4s ·354
```

## 根因

`src/runtime/workflow-runtime.ts:411-412`：

```typescript
const assignedPhase = scriptOptions.phase ?? scope.currentPhase
const displayPhase = scope.phasePrefix ? scope.phasePrefix + assignedPhase : assignedPhase
```

当子 Workflow 脚本未声明 `meta.phases` 且未调用 `phase()` 时：

1. `meta.phases?.[0]?.title` 为 `undefined`（`workflow-runtime.ts:349`），`scope.currentPhase` 保持 `undefined`
2. `assignedPhase = scriptOptions.phase ?? scope.currentPhase` = `undefined`
3. `scope.phasePrefix` = `"▸ child_seq / "`（子 Workflow 非空前缀）
4. `displayPhase = "▸ child_seq / " + undefined` = `"▸ child_seq / undefined"`

JavaScript 字符串拼接把 `undefined` 强转为字符串 `"undefined"`。

## 影响范围

- agent record 的 `phase` 字段写入 `"▸ child_seq / undefined"`（journal、快照、metadata 全链路）
- TUI 侧边栏 phase 标题行和节点行都显示这个字符串
- hash 身份含 `displayPhase`（`hashAgentCall` 第三参数），不影响正确性（同脚本同 agent 的 hash 一致），但日志可读性差

## 修复方案

`workflow-runtime.ts:412`，`assignedPhase` 为 `undefined` 时不拼前缀：

```typescript
// 修复前
const displayPhase = scope.phasePrefix ? scope.phasePrefix + assignedPhase : assignedPhase

// 修复后
const displayPhase = assignedPhase
  ? (scope.phasePrefix ? scope.phasePrefix + assignedPhase : assignedPhase)
  : scope.phasePrefix?.replace(/ \/$/, "")  // 有前缀无 phase 时只显示子流程名（去掉尾部 " / "）
```

或更简单：`undefined` 时前缀也省略：

```typescript
const displayPhase = assignedPhase
  ? (scope.phasePrefix ? scope.phasePrefix + assignedPhase : assignedPhase)
  : undefined
```

第二种方案会让无 phase 的子 Workflow agent 的 `record.phase` 为 `undefined`，TUI 侧 `derivePhases` 已容忍无 phase 的 agent（不产生 phase 条目），不会回归。

## 注意事项

- 修复后需验证 `workflow-runtime.test.ts` 中 `phase 与 log 被记录` 用例不回归（该用例声明了 phases）
- `workflow-observability.test.ts` 的 `root 与 child 各生成 record` 用例的 child 无 phases，修复后 `child.phase` 从 `"▸ sub / undefined"` 变为 `undefined`，需同步更新断言
- hash 身份不受影响：`hashAgentCall` 对 `undefined` 和 `"▸ sub / undefined"` 产生不同 hash，但同脚本同 agent 的一致性不变（都是同一个值）

## 涉及文件

- `src/runtime/workflow-runtime.ts:411-412`（根因）
- `tests/workflow-runtime.test.ts`（phase 记录用例）
- `tests/workflow-observability.test.ts`（child record 用例）
