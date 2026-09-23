// Composite V1 验收：resume 下 sequence 内 agent 全量回放
export const meta = { name: 'composite_seq_resume', description: 'sequence resume 回放' }
phase('前置')
await agent('回复固定文本：PARENT-PROBE')
phase('编排')
const r = await sequence([
  () => agent('回复固定文本：SEQ-NODE-1'),
  (prev) => agent('把上一步的返回文本原样重复一遍，不要加任何其他字：' + prev),
])
return { parent: 'PARENT-PROBE', seq: r }
