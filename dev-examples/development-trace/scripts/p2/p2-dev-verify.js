/**
 * P2 Development 模式验证 Workflow
 *
 * 目标：执行 development: true 的 Workflow，验证自动触发 Optimizer Job，
 *       产出 analysis/report.md 与 proposals.json，且防递归。
 *
 * 覆盖场景：
 *  - 3 个 Agent 各使用不同工具（read / write / bash）
 *  - 1 个子 Workflow（验证执行树层级）
 *  - development: true（验证 Optimizer 自动触发）
 *
 * 执行方式：在本目录启动 opencode 后调用：
 *   workflow({ scriptPath: "./scripts/p2/p2-dev-verify.js", development: true, background: false })
 *
 * 执行完成后验证 Development Job 与分析报告：
 *   npx tsx scripts/p2/verify-p2-dev.ts <runId>
 *
 * 预期产出：
 *   .opencode-workflows/
 *   ├── development/
 *   │   └── jobs.json                 Job status=completed, originRunId=<runId>
 *   └── history/
 *       └── <runId>/
 *           ├── manifest.json          P1 已有
 *           ├── history.jsonl          P1 已有
 *           ├── history.md             P1 已有
 *           └── analysis/
 *               ├── report.md          Optimizer 生成
 *               └── proposals.json     Optimizer 生成
 */

export const meta = {
  name: "p2_dev_verify",
  description: "P2 Development 模式验证：development:true 自动触发 Optimizer",
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
  "用 write 工具在当前工作目录创建文件 p2_test_output.txt，内容为：\n" +
    "P2 Development Test\n" +
    "Optimizer auto-trigger verified\n" +
    "创建完成后报告文件路径",
  { agentType: "general", label: "文件写入" },
)

// Phase 3: 调用子 Workflow（验证 Optimizer 能解析执行树）
phase("子工作流")
const childResult = await workflow({ scriptPath: "./scripts/p2/p2-child.js" })

// Phase 4: Agent 运行命令验证文件
phase("执行验证")
const runResult = await agent(
  "用 bash 工具运行命令：type p2_test_output.txt（Windows）或 cat p2_test_output.txt（Linux），报告输出内容",
  { agentType: "general", label: "执行验证" },
)

return {
  configInfo,
  writeResult,
  childResult,
  runResult,
  summary: "P2 Development 验证完成：4 阶段 3 Agent + 1 子 Workflow，development:true",
}
