/**
 * P3 子 Workflow：被 p3-analyzer-verify.js 调用
 *
 * 供耗时分布规则分析嵌套开销。
 */

export const meta = {
  name: "p3_child",
  description: "P3 子 Workflow：供结构化分析器检测嵌套开销",
}

const result = await agent(
  "用 read 工具读取当前工作目录的 tui.json 文件，报告内容摘要（一句话）",
  { agentType: "general", label: "子WF读取配置" },
)

return result
