# /workflow 界面 j k 切换时选中箭头不更新问题

## 现象

输入 `/workflow` 打开 workflow 全屏路由视图，按 `j` / `k` 在 agent 节点间上下切换时，
agent 行前的箭头光标（`▸`）没有跟着移动，停留在旧位置；背景高亮疑似同样不更新。
滚动跟随（scrollChildIntoView）是否正常待确认。

## 复现步骤

1. 启动一个多 agent 的 workflow run（前台或后台均可）
2. 输入 `/workflow` 打开路由视图，sidebar 树出现节点
3. 按 `j` 或 `k` 切换选择
4. 箭头 `▸` 与面板底色未随选中移动

## 相关代码锚点（2026-09 快照，行号以当前源码为准）

| 位置 | 职责 |
|---|---|
| src/tui/plugin.tsx:46 | `const [selectedNode, setSelectedNode] = createSignal(null)` 选中键信号 |
| src/tui/plugin.tsx:316-321 | `move(delta)`：moveSelection 算下一键，setSelectedNode，随后 scrollChildIntoView |
| src/tui/plugin.tsx:410-411 | 行渲染处 `selected = selectedNode() === key`，key 来自 selectionKey(runId, nodeId) |
| src/tui/plugin.tsx:423 | 箭头渲染 `selected ? "▸ " : "  "` 与背景色 |
| src/tui/workflow-store.ts:190-197 | selectionKey / selectableNodeKeys / moveSelection 纯函数 |

## 初步分析（两个方向，待验证）

方向一（嫌疑最大）：`selectedNode()` 的读取不在响应式作用域内。
若多树行数组是先在 createMemo（仅依赖 progresses）里构建、再以非 JSX 惰性方式
渲染，则 selected 的读取发生在 memo 求值期，setSelectedNode 后行不重渲。
特征是：滚动跟随正常（move 里直接调用），仅 `▸`/底色不动。

方向二：solid-js 双实例或 For 列表项缓存问题。但本项目 solid 用法已收敛在
plugin.tsx 单文件（AGENTS.md 约束），双实例概率低；For 项内读取信号本应逐项追踪。

## 验证与修复建议（后续处理）

1. 在 move() 里 log selectedNode 前后值，确认信号确实变化
2. 在行渲染处 log selected，确认切换后是否重新求值；不重新求值即坐实方向一
3. 修复思路：把 `selected` 的读取移回 JSX 惰性表达式（如 `selected={selectedNode() === key}`
   作为属性内联），或将行渲染拆成独立组件确保逐项追踪
4. 回归点：多树同显（跨 run 切换）、Enter 进子会话、Esc 返回后选中态保持

## 关联

- 本问题仅记录，未修复；修复时同步更新 examples/sample-project/TUI测试指南.md
- 结构相关文档：Docs/02_设计与说明/TUI实时通道优化方案.md
