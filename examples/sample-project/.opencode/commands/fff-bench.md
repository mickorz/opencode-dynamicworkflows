---
description: "运行 FFF 文件搜索性能基准 workflow（.opencode/workflows/fff-search-benchmark.js），输出 JSON 结果。用于 OPENCODE_DISABLE_FFF A/B 测试，由 benchmarks/run-fff-bench.ps1 经 opencode run --command fff-bench --auto 调用。"
---

# fff-bench

调用 `workflow` 工具执行文件搜索性能基准，参数：

- `scriptPath`: `.opencode/workflows/fff-search-benchmark.js`

执行完成后，把 workflow 返回的 JSON 结果**原样**作为最终回复输出。

不要添加任何总结、分析、解释或额外说明文字，只输出 workflow 返回的那段 JSON。
