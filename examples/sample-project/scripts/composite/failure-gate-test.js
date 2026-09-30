// Bug1 修复实机验收：阶段失败闸门——第一个 agent 让它失败（重试耗尽），观察：
// 1. 失败后同 phase 的 bookkeeping agent 照常收尾
// 2. 下一 phase() 边界终止 run，报错含失败明细与续跑提示
export const meta = { name: 'failure_gate', description: '阶段失败闸门实机验收' }
phase('执行')
// timeoutMs:1 做确定性失败注入（1ms 必超时；retries:0 立即耗尽触发闸门）
const bad = await agent('回复任意文本（此调用 1ms 超时必失败）', { label: '会失败的节点', timeoutMs: 1, retries: 0 })
phase('汇总')
return { bad }
