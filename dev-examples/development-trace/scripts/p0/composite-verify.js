/**
 * Composite 身份冲突验证脚本
 *
 * 目标：并行兄弟子 Workflow 各含 sequence 组合节点，
 *       验证修复后 cmpN 重名不导致进度互相覆盖。
 *
 * 执行方式：在本目录启动 opencode 后调用：
 *   workflow({ scriptPath: "./scripts/p0/composite-verify.js" })
 *
 * 预期：两个并行子 Workflow 各执行一个 sequence，
 *       TUI 侧两个组合节点都正确显示，不互相覆盖。
 */

export const meta = {
  name: "composite_verify",
  description: "验证 Composite 身份冲突修正：并行兄弟子 Workflow 的 cmpN 不碰撞",
}

// 用 parallel 同时跑两个相同子 Workflow（兄弟 scope 各产生 cmp0）
const results = await parallel([
  () => workflow({ scriptPath: "./scripts/p0/child-seq.js" }),
  () => workflow({ scriptPath: "./scripts/p0/child-seq.js" }),
])

return {
  childCount: results.length,
  summary: "两个并行子 Workflow 各含 sequence，验证 cmpN 重名不冲突",
}
