// Bug1 修复实机验收：阶段失败闸门——第一个 agent 让它失败（重试耗尽），观察：
// 1. 失败后同 phase 的 bookkeeping agent 照常收尾
// 2. 下一 phase() 边界终止 run，报错含失败明细与续跑提示
export const meta = { name: 'failure_gate', description: '阶段失败闸门实机验收' }
phase('执行')
const bad = await agent('请直接回复固定文本：失败场景演示', { label: '会失败的节点', retries: 0 })
phase('汇总')
return { bad }
