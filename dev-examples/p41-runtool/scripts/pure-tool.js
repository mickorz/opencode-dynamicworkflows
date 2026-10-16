/**
 * P4.1-B 纯 runTool Workflow 验收脚本（零 Agent 零 token）
 */
export const meta = {
  name: "pure_tool_verify",
  description: "P4.1-B 验收：runTool 双模式 + parseJson + 纯工具流合法性",
  phases: [{ title: "确定性执行" }],
}

phase("确定性执行")
const probe = await runTool("tools/probe.py", { parseJson: true })
const missing = await runTool("tools/absent.py", { onFailure: "return" })

return {
  probeOk: probe.ok,
  probeParsed: probe.parsed,
  missingOk: missing.ok,
  missingExitCode: missing.exitCode,
}
