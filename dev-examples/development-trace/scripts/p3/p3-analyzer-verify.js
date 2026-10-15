/**
 * P3 结构化分析器验证 Workflow (v3)
 *
 * 目标：触发五类分析规则，验证 TypeScript 代码分析（非 LLM 驱动）的正确性。
 *
 * 覆盖场景（对应五类规则）：
 *  - Rule 1 重复操作：Phase 1 读取同一文件两次（仅 Observation，不直接生成 Proposal）
 *  - Rule 2 失败重试：第一版不主动触发（Agent 可能成功），分析器能检测但不保证场景出现
 *  - Rule 3 顺序依赖：Phase 2 写脚本文件，Phase 4 执行该文件（write→bash 依赖链）
 *  - Rule 4 耗时分布：Phase 3 子 Workflow（嵌套开销可被检测，仅 Observation）
 *  - Rule 5 Script Extraction：Phase 2 写 Python 脚本，Phase 4 用 bash 执行该脚本
 *    （触发 script extraction 候选，determinism=likely）
 *
 * 执行方式：在本目录启动 opencode 后调用：
 *   workflow({ scriptPath: "./scripts/p3/p3-analyzer-verify.js", development: true, background: false })
 *
 * 执行完成后验证结构化分析：
 *   npx tsx scripts/p3/verify-p3-analysis.ts <runId>
 *
 * 预期产出：
 *   .opencode-workflows/history/<runId>/analysis/
 *   ├── report.md          结构化分析报告（五节规则）
 *   ├── proposals.json     优化候选（含 candidateFingerprint + category + evidence）
 *   └── enrichment.md      Agent 审阅增补（仅在 Optimizer 成功时存在）
 */

export const meta = {
  name: "p3_analyzer_verify",
  description: "P3 结构化分析器验证：触发五类分析规则",
  phases: [
    { title: "重复读取" },
    { title: "写入脚本" },
    { title: "子工作流" },
    { title: "执行脚本" },
  ],
}

// Phase 1: 两次读取同一文件（触发重复操作检测，仅 Observation）
phase("重复读取")
const read1 = await agent(
  "用 read 工具读取当前工作目录的 opencode.json 文件，报告 plugin 字段内容",
  { agentType: "general", label: "首次读取" },
)
const read2 = await agent(
  "用 read 工具再次读取当前工作目录的 opencode.json 文件，确认内容未变",
  { agentType: "general", label: "二次读取" },
)

// Phase 2: 写入 Python 脚本文件（后续 Phase 4 执行，触发 Script Extraction + 顺序依赖链）
// 脚本内容为确定性逻辑（无时间戳与随机数），determinism 应为 likely
phase("写入脚本")
const writeResult = await agent(
  "用 write 工具在当前工作目录创建文件 p3_validate.py，内容为：\n" +
    "import json\n" +
    "import sys\n" +
    "\n" +
    "def validate(config):\n" +
    "    if not isinstance(config, dict):\n" +
    "        return False\n" +
    "    return 'plugin' in config\n" +
    "\n" +
    "if __name__ == '__main__':\n" +
    "    with open(sys.argv[1], 'r') as f:\n" +
    "        result = validate(json.load(f))\n" +
    "    print('valid' if result else 'invalid')\n" +
    "创建完成后报告文件路径",
  { agentType: "general", label: "脚本写入" },
)

// Phase 3: 子 Workflow（触发嵌套开销检测，仅 Observation）
phase("子工作流")
const childResult = await workflow({ scriptPath: "./scripts/p3/p3-child.js" })

// Phase 4: 执行 Phase 2 写入的脚本（完成 Script Extraction 闭环 + 依赖链闭环）
phase("执行脚本")
const verifyResult = await agent(
  "用 bash 工具运行命令：python p3_validate.py opencode.json，报告输出内容",
  { agentType: "general", label: "脚本执行" },
)

return {
  read1,
  read2,
  writeResult,
  childResult,
  verifyResult,
  summary: "P3 结构化分析器验证完成：4 阶段 5 Agent + 1 子 Workflow，触发五类规则",
}
