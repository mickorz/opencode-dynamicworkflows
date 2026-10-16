/**
 * P4.1-A Similar Match 验收 Workflow：两轮运行的临时脚本仅注释不同
 * （L0 指纹不同、L1 规范化相同 -> 相似组 similar-candidate）。
 */
export const meta = {
  name: "p41_similar_verify",
  description: "P4.1-A 相似匹配验证：注释差异脚本聚合",
  phases: [{ title: "写入脚本" }, { title: "执行脚本" }],
}

phase("写入脚本")
const writeResult = await agent(
  "先用 bash 工具运行 date +%s 拿到当前时间戳，然后用 write 工具创建文件 p41_check.py，" +
    "内容必须严格为以下代码、但在文件第一行添加注释 # build <刚才的时间戳>：\n" +
    "import json\n" +
    "def validate(config):\n" +
    "    if not isinstance(config, dict):\n" +
    "        return False\n" +
    "    return 'plugin' in config\n" +
    "with open('opencode.json') as f:\n" +
    "    print('valid' if validate(json.load(f)) else 'invalid')\n" +
    "创建后报告文件路径与时间戳。",
  { agentType: "general", label: "脚本写入" },
)

phase("执行脚本")
const verifyResult = await agent(
  "用 bash 工具运行命令：python p41_check.py，报告输出内容",
  { agentType: "general", label: "脚本执行" },
)

return { writeResult, verifyResult }
