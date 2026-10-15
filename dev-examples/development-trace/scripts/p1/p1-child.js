/**
 * P1 子 Workflow：被 p1-history-verify.js 调用
 *
 * 验证 History 执行树中子 Workflow 的层级与 scopePath 正确记录。
 * 执行方式：由 p1-history-verify.js 通过 workflow({ scriptPath }) 调用。
 */

export const meta = {
  name: "p1_child",
  description: "P1 子 Workflow：测试 History 执行树层级",
}

const result = await agent(
  "用 read 工具读取当前工作目录的 tui.json 文件，报告内容摘要（一句话）",
  { agentType: "general", label: "子WF文件读取" },
)

return result
