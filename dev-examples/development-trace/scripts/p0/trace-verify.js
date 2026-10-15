/**
 * Development Trace 验证脚本
 *
 * 目标：让 Agent 在执行过程中动态创建并运行临时脚本，
 *       验证 session.messages() 能否完整采集这些工具调用。
 *
 * 执行方式：在本目录启动 opencode 后调用：
 *   workflow({ scriptPath: "./scripts/trace-verify.js" })
 *
 * 预期：Agent 会 read 一个文件、write 一个 Python 脚本、bash 运行它、edit 修改后重跑。
 *       结束后可用 session.messages() 拉取全部 ToolPart，
 *       parseSessionMessages() 解析出完整工具调用序列与脚本内容。
 */

export const meta = {
  name: "trace_verify",
  description: "验证 Development Trace 采集能力：Agent 动态创建并运行临时脚本",
  phases: [
    { title: "读取基线" },
    { title: "生成脚本" },
    { title: "执行验证" },
  ],
}

// Phase 1: 读取项目中的文件
phase("读取基线")
const fileList = await agent(
  "列出当前工作目录下的所有 .json 文件名（只文件名，逗号分隔），用 read 工具读取项目根目录。",
  { agentType: "general", label: "文件扫描" },
)

// Phase 2: 让 Agent 动态创建一个 Python 脚本
phase("生成脚本")
const scriptContent = await agent(
  "用 write 工具在当前工作目录创建文件 verify_trace.py，内容为：\n" +
    "import json\n" +
    "import os\n" +
    "print('trace verify started')\n" +
    "print('cwd:', os.getcwd())\n" +
    "print('files:', [f for f in os.listdir('.') if f.endswith('.json')])\n" +
    "print('trace verify done')\n" +
    "创建完成后报告文件路径。",
  { agentType: "general", label: "脚本创建" },
)

// Phase 3: 让 Agent 运行脚本，失败则修改后重跑
phase("执行验证")
const runResult = await agent(
  "用 bash 工具运行 python verify_trace.py，报告输出结果。如果报错，用 edit 工具修复后重跑。",
  { agentType: "general", label: "脚本执行" },
)

return {
  fileList,
  scriptContent,
  runResult,
}
