# Composite 控制流讨论记录索引

本目录是「workflow 拓展 PandaBT 风格组合控制流」需求的 4 轮 AI 对话原始记录，按时间顺序编号。

最终结论已汇总为独立计划文档，以该文档为唯一事实来源：

- [../Composite控制流开发计划V1.md](../Composite控制流开发计划V1.md) — P0/P1/P2 分阶段开发计划（定稿）

## 演进关系

| 编号 | 文档 | 时间 | 核心结论 |
|---|---|---|---|
| 01 | [PandaBT语法拓展初探](01-PandaBT语法拓展初探.md) | 09-22 | 首轮讨论：值得加树状组合语法但不替换 JS；提出 NodeResult 统一、8 节点候选清单 |
| 02 | [必要性与优先级评估](02-必要性与优先级评估.md) | 09-23 上午 | sequence 单独必要性仅 4/10；真正价值是 Composite Node 模型；四象限（sequence/fallback/parallel/race） |
| 03 | [风险评估与分阶段策略](03-风险评估与分阶段策略.md) | 09-23 上午 | 8 类风险（失败语义/journal-resume 最关键）；5 个安全阶段；Regression Matrix；红线「Add Composite Layer, don't rewrite the Engine」 |
| 04 | [sequence与pipeline冲突分析](04-sequence与pipeline冲突分析.md) | 09-23 上午 | pipeline 是 Concurrent Item Pipeline 与 sequence 不冲突；建议改名 processEach 并降级为 helper，渐进 deprecated |

## 关键决策（讨论中收敛的定论）

1. 不做 .flow DSL / Stable Node ID / parallel 重写 / pipeline 立即删除
2. Node 执行状态（success/failure/cancelled）与业务结果（如 {ok:false}）严格分离，禁止 `!value` 即 failure
3. sequence 第一版不占 journal callIndex，对 resume 透明
4. 核心四节点：sequence / fallback / parallel / race；repeat/guard/invert 延后 P2
5. 开发前必须先冻结行为基线（Golden Tests），race 前必须先做 Composite Local Abort Scope
