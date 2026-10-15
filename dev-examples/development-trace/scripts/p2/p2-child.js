/**
 * P2 子 Workflow：被 p2-dev-verify.js 调用
 *
 * 验证 Optimizer 能正确解析含子 Workflow 的执行树。
 */

export const meta = {
  name: "p2_child",
  description: "P2 子 Workflow：验证 Optimizer 执行树分析",
}

const result = await agent(
  "用 read 工具读取当前工作目录的 tui.json 文件，报告内容摘要（一句话）",
  { agentType: "general", label: "子WF读取配置" },
)

return result
