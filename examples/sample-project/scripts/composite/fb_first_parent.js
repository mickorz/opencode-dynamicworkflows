// Composite V1 验收：fallback 首个候选成功即返回，后续完全跳过
export const meta = { name: 'composite_fb_first', description: 'fallback 首选成功' }
phase('编排')
const r = await fallback([
  () => ({ provider: 'fast', note: '快路径直接成功' }),
  () => workflow('./scripts/native/1_spec.js'),
])
return { winner: r.provider, secondRan: false }
