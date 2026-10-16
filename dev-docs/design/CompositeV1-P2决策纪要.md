# Composite V1 P2 决策纪要

> 对应 `Docs/01_需求与规划/Composite控制流开发计划V1.md` 的 P2-1 / P2-2 / P2-4 三项决策。
> 依据：P1-4 Pipeline 等价性 A/B（`tests/pipeline-ab.test.ts` 7 用例全等价，报告见同目录
> `Pipeline等价性AB报告.md`）与 P1-5 LLM Generation A/B 评估方案（实机执行待办）。

## P2-1 Pipeline 去留：降级为 Convenience Helper，保留 API

**决策**：
- `pipeline()` 保留公开 API，不做 Breaking Change（npm 现有用户）
- 文档层引导迁移：skill 已标注「等价于 parallel+sequence 组合，新脚本优先组合写法」（commit a9c59f1）
- 内部实现**不替换**：等价性已证，替换无收益只有风险；留待 1.0 周期统一处理
- 不标注 JSDoc 级 deprecated（避免现有用户告警噪音），以引导而非强制

**理由**：A/B 显示全维度等价（结果/journal key/null 传播/塌缩/结构错/并发峰值/resume），
pipeline 无独占语义价值；但删除的收益（少一份 API 文档）远小于 Breaking Change 的成本。

## P2-2 processEach：不做

**决策**：不新增 `processEach(items, ...stages)` 别名。

**理由**：与 pipeline 语义完全等价（A/B 已证），加别名 = 同一行为两个名字，
增加 skill 教学面与 LLM 选型困惑；pipeline 名字在「已标注组合等价」后不再有误导性。
若未来删除 pipeline（1.0），届时直接引导 parallel+sequence，无需中间别名。

## P2-4 repeat / guard / invert / alwaysSuccess：本版不做，gate 在 LLM A/B

**决策**：V1 不实现任何 PandaBT 装饰节点。

**理由**（对齐风险评估文档的优先级表）：

| 节点 | 现有覆盖 | 评估 |
|------|----------|------|
| repeat | `retry(fn, {attempts, until})` | 语义覆盖，仅缺「组合树内的展示层级」 |
| guard | JS `if` | 一行 if 比 guard() 更直白 |
| invert | JS `!` | 无增益 |
| alwaysSuccess | JS try/catch | 无增益 |

计划原文的判据：**LLM Generation A/B 没有明显提升前，不扩 DSL**。P1-5 的 A/B 实机执行
是唯一门槛——若 B 组（Composite skill）首过率显著优于 A 组，再评估 repeat（组合树展示价值）；
否则冻结。

## P2-3 与 P2-5 状态

- P2-3 Composite TUI 树：已实现（commit bef1d68）——CompositeRecord / compositePath /
  onCompositeUpdate / 快照与 metadata 透传 / sidebar 组合分组行 `[Sequence]`
- P2-5 Stable Node ID：调研文档另附（`StableNodeID调研.md`），结论为 V2 再动
