/**
 * Optimizer 内置脚本（P3 v3）
 *
 * P3 变更：
 *  - 接收预计算状态（reviewMode, analysisMode, analysisStatus, proposalCount）
 *  - 分支 A (deterministic-success)：读取预写报告，只做审阅和增补
 *  - 分支 B1 (llm-fallback)：自行读取 history 进行分析
 *  - v3 bug 修正：将 review 变量传入增补 Agent 的 prompt
 *
 * args 透传：{ originRunId, historyPath, reviewMode, analysisMode, analysisStatus, proposalCount, analysisError }
 */

export const OPTIMIZER_SCRIPT = `export const meta = {
  name: "development_optimizer",
  description: "审阅与增补预计算分析报告",
  phases: [
    { title: "审阅报告" },
    { title: "增补洞察" },
  ],
}

const historyPath = args.historyPath
const analysisPath = historyPath + "/analysis"
const reviewMode = args.reviewMode || "deterministic-success"
const analysisMode = args.analysisMode || "deterministic"
const analysisStatus = args.analysisStatus || "completed"
const analysisError = args.analysisError || ""
const proposalCount = args.proposalCount || 0

phase("审阅报告")

let reviewPrompt
if (reviewMode === "deterministic-success") {
  // 分支 A：确定性分析成功，读取预写报告
  reviewPrompt = "用 read 工具读取 " + analysisPath + "/report.md 和 " + analysisPath + "/proposals.json。" +
    "确定性分析已完成（模式：" + analysisMode + "，状态：" + analysisStatus + "，候选数：" + proposalCount + "）。" +
    "检查分析是否准确，是否有遗漏的模式或误判。" +
    "用一句话总结审阅结论。"
} else {
  // 分支 B1：确定性分析失败，History 可用，LLM 自行分析
  reviewPrompt = "确定性分析失败（错误：" + analysisError + "）。" +
    "用 read 工具读取 " + historyPath + "/history.md 和 " + historyPath + "/history.jsonl。" +
    "基于 History 数据自行分析 Workflow 执行模式，重点关注：" +
    "1. 临时脚本创建与执行 2. 重复操作 3. 失败重试 4. 耗时分布。" +
    "用一句话总结分析结论。"
}

const review = await agent(reviewPrompt, {
  agentType: "general",
  label: "报告审阅",
})

phase("增补洞察")

// v3 关键修正：将审阅结果 review 传入增补 Agent 的 prompt
// v2 bug：第二个 Agent 的提示词写着"基于审阅结果"但未实际传入 review 变量
const enrichment = await agent(
  "审阅结论：" + (review.result || review) + "\\n\\n" +
  "基于上述审阅结论，用 write 工具在 " + analysisPath + "/ 目录下创建 enrichment.md，" +
  "补充以下内容（如果预计算报告已充分覆盖则写'无需增补'）：\\n" +
  "1. 预计算报告未覆盖的模式或洞察\\n" +
  "2. 对 proposals 的优先级建议\\n" +
  "3. 需要人工确认的风险点\\n" +
  (reviewMode === "llm-fallback"
    ? "4. 基于你刚才的分析，补充基础优化建议\\n"
    : "") +
  "5. 明确标注哪些 Proposal 建议优先实施",
  { agentType: "general", label: "洞察增补" },
)

return { originRunId: args.originRunId, review, enrichment, reviewMode, analysisMode, analysisStatus }
`
