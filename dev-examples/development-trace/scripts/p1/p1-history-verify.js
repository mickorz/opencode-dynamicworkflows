/**
 * P1 History 落盘验证 Workflow
 *
 * 目标：执行多 Agent + 子 Workflow，验证 RunFinalizer 采集 Trace 并生成 History。
 *
 * 覆盖场景：
 *  - 3 个 Agent 各使用不同工具（read / write / bash）
 *  - 1 个子 Workflow（验证执行树层级 scopePath）
 *  - 4 个 phase 阶段（验证事件时间线排序）
 *
 * 执行方式：在本目录启动 opencode 后调用：
 *   workflow({ scriptPath: "./scripts/p1/p1-history-verify.js", background: false })
 *
 * 执行完成后检查 History 落盘：
 *   npx tsx scripts/p1/verify-p1-history.ts <runId>
 *
 * 预期 History 结构：
 *   .opencode-workflows/history/<runId>/
 *     manifest.json      completeness=full, sessions=4(3 agent + 1 child agent)
 *     traces/*.jsonl     每个非回放 session 一条
 *     history.jsonl      全局时间线，按时间排序
 *     history.md         人可读视图，含执行树 + 工具序列
 */

export const meta = {
  name: "p1_history_verify",
  description: "P1 History 落盘验证：多 Agent 工具调用 + 子 Workflow 执行树",
  phases: [
    { title: "文件扫描" },
    { title: "脚本生成" },
    { title: "子工作流" },
    { title: "执行验证" },
  ],
}

// Phase 1: Agent 读取配置文件
phase("文件扫描")
const configInfo = await agent(
  "用 read 工具读取当前工作目录的 opencode.json 文件，报告其中 plugin 字段的内容（一句话）",
  { agentType: "general", label: "配置读取" },
)

// Phase 2: Agent 写入临时文件
phase("脚本生成")
const writeResult = await agent(
  "用 write 工具在当前工作目录创建文件 p1_test_output.txt，内容为：\n" +
    "P1 History Test\n" +
    "Workflow trace collection verified\n" +
    "创建完成后报告文件路径",
  { agentType: "general", label: "文件写入" },
)

// Phase 3: 调用子 Workflow（验证执行树层级）
phase("子工作流")
const childResult = await workflow({ scriptPath: "./scripts/p1/p1-child.js" })

// Phase 4: Agent 运行命令验证文件
phase("执行验证")
const runResult = await agent(
  "用 bash 工具运行命令：type p1_test_output.txt（Windows）或 cat p1_test_output.txt（Linux），报告输出内容",
  { agentType: "general", label: "执行验证" },
)

return {
  configInfo,
  writeResult,
  childResult,
  runResult,
  summary: "P1 History 验证完成：4 阶段 3 Agent + 1 子 Workflow",
}
