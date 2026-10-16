# Pipeline 等价性 A/B 报告（P1-4）

> 结论先行：**pipeline(items, ...stages) 与 parallel + sequence 组合在全部可测维度上行为等价**。
> 依据本报告，P2 可将 pipeline 从 Core Primitive 降级为 Convenience Helper（内部逐步改写为组合实现），
> 但**不建议本版本删除 API**（npm 现有用户 Breaking Change），维持现状到 1.0 前的 deprecated 兼容期。
>
> 测试证据：`tests/pipeline-ab.test.ts`（7 用例全绿）
> 决策输入：`Docs/01_需求与规划/Composite控制流开发计划V1.md` P2-1

## 对照体

```js
// Old（Core Primitive）
await pipeline(items, A, B, C)

// New（Composite 组合）
await parallel(
  items.map(item => () => sequence([
    () => A(item, item, 0),
    prev => B(prev, item, 0),
    prev => C(prev, item, 0),
  ]))
)
```

## 测量矩阵与结果

| 维度 | 结果 | 说明 |
|------|------|------|
| 纯 JS stage 结果 | 等价 | 逐项 deepEqual |
| agent stage 结果 | 等价 | 返回值一致 |
| journal key 序 | 等价 | 两形态 callSeq 均按 item 声明序同步分配，key 形态一致 |
| null 传播 | 等价 | stage 返回 null 后续 stage 以 null 继续；sequence 对 null 视为 success 同样继续（基线测试已钉死两边行为） |
| 可恢复失败 | 等价 | 对应 item 塌缩为 null，其余 item 照常完成 |
| 结构性错误 | 等价 | unknown workflow 等非可恢复错误两形态均上抛，不塌缩 |
| 并发峰值 | 等价 | 均 item 级并发、无 stage barrier，峰值相同 |
| resume | 等价 | 同 runId 全量回放，两形态 journal 均命中 |
| wall time | 结构等价 | fake runner 无法测真实耗时；两形态均无 barrier、同调度序，结构性等价 |
| 内存 | 未测 | 1000+ item 场景需实机压测；两形态均为「map 一次性建链」，无已知差异源 |

## 语义差异清单（已知且可接受）

1. **stage 签名**：pipeline stage 收 `(prev, original, index)`；sequence 节点只收 `(prev)`。组合写法需在节点内闭包捕获 original/index（上例已演示）。
2. **stage 间中止检查**：pipeline 在每个 stage 前后显式 `throwIfAborted`；sequence 依赖节点内部的 agent()/workflow() 自检，纯 JS 节点之间不查中止。中止迟到一个节点的粒度，可接受。
3. **失败日志文案**：`pipeline[i] 失败` vs `sequence[j] 失败`（定位粒度略有差异）。

## 决策建议（供 P2 执行）

- pipeline 保留 API、文档标注 deprecated，推荐迁移到 parallel + sequence 或 processEach（P2-2 再评估命名）
- 内部实现暂不替换（等价性已证，替换无收益只有风险；等 1.0 周期再动）
- workflow-authoring skill 中新脚本优先教 Composite 写法（P1-6 同步）
