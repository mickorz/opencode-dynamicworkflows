export const meta = { name: 'child_seq' }
const r = await sequence([
  () => agent('读取当前目录文件列表并简要报告', { agentType: 'general' }),
  () => agent('基于上一步的发现做一句话总结', { agentType: 'general' }),
])
return r
