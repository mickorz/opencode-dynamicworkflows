// question 型 checkpoint 实机验收（#35）：官方选项对话框 + journal 回放续跑
// 预期链路：挂起 -> 主 agent 弹 question 对话框 -> 作答 -> checkpoint_reply -> 续跑回放 -> 完成
export const meta = { name: 'qcp_e2e', description: 'question 型 checkpoint 端到端验收' }
phase('闸门')
const before = await agent('回复固定文本：准备完成')
const answer = await checkpoint('选择本阶段产物的处置方式', {
  header: '处置方式',
  options: [
    { label: '归档', description: '保存到 docs 目录' },
    { label: '丢弃', description: '不保留产物' },
  ],
})
phase('执行')
const after = await agent('按处置方式「' + String(answer && answer[0]) + '」执行并回复固定文本：已处置')
return { before, answer, after }
