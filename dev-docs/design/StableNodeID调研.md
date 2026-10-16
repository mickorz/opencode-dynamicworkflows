# Stable Node ID 调研（P2-5）

> 对应 `Docs/01_需求与规划/Composite控制流开发计划V1.md` P2-5。结论：**V1 不做，V2 按需启动**。

## 现状：位置寻址（Position-based）

```
journal key = runId:[wfK...]:callIndex
```

- agent/checkpoint 按 scope 内调用位置（callSeq）编号
- child workflow 按创建顺序（childSeq -> wfN）编号
- resume 语义：最长未变前缀回放——首个 hash 不匹配或缺失的调用及其之后全部重跑

## 痛点（何时会疼）

1. **脚本中段插入/删除调用**：后续所有 callIndex 漂移，全部重跑（即使内容没变）
2. **fallback/race 分支翻转**：走了另一条分支后，后续编号漂移重跑（V1 已接受，见风险文档）
3. **parallel 内调整顺序**：槽位交换导致对应 key 漂移

痛点 1/3 是真实成本（大 run 中段改一行，后面几十个 agent 全重跑烧 token）；
痛点 2 是组合语义固有，Stable ID 也只能部分缓解。

## 候选方案

| 方案 | 形态 | 优点 | 代价 |
|------|------|------|------|
| A. 声明式节点 ID | 脚本里给节点命名：`agent('...', { id: 'design.frontend' })`，journal key 用声明 ID | 精准、可读、resume 稳定 | API 面 +1 选项；skill 要教；LLM 生成时可能乱起名导致碰撞 |
| B. 内容寻址 | key = hash(prompt+options)，与位置无关 | 零 API 变化；改脚本不动某 agent 即命中 | 同 prompt 不同位置会互相命中（语义可能不同）；哈希碰撞面需处理 |
| C. AST 结构指纹 | 解析脚本生成结构签名，节点按结构位置稳定寻址 | 对脚本作者透明 | acorn 深度集成；重构等价代码（改写法）即失效；实现复杂度最高 |

## 影响面（为什么不能塞进 V1）

```
journal key 格式（持久化兼容） -> resume 匹配器 -> checkpoint 寻址
-> child workflow wfN（与节点 ID 的层级关系）
-> TUI 节点反查/选中键 -> runs 快照 -> schedule 续跑
```

任何方案都同时动 6 个面，且需要 journal 格式版本迁移（老 run 的续跑兼容）。

## 建议

1. V1 维持位置寻址（现状已可工作，Composite 三态不依赖节点 ID）
2. 若 P1-5 LLM A/B 显示 Composite 显著提升、且用户实际反馈「中段修改导致大额重跑」成为高频成本，
   V2 优先做**方案 A（声明式节点 ID，仅 agent/checkpoint 可选）**：
   - 向后兼容：无 id 时回落 callIndex 寻址（老脚本零影响）
   - journal key 演进：`runId:wfK:declared-id`，与 wfN 层级正交
   - 复合节点不强制命名（组合层已有 cmpN 展示寻址，P2-3）
3. 方案 B/C 不建议：B 的误命中风险不可控，C 的复杂度与收益不成比例

## 参考

- 位置/声明混合的先例：Pi coding agent 的 agentId（thread 内声明 ID + 位置回退）
- 本仓库现状锚点：`src/runtime/workflow-runtime.ts` 的 `scopedKey` / `firstMiss` 注释，
  `tests/workflow-journal.test.ts` 的最长未变前缀用例
