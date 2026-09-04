// 范例：分阶段流水线 —— pipeline 串起"读取 -> 整形 -> 汇总"三段
// 演示 stage 签名 (previousValue, originalItem, index) 与 phase 切换

export const meta = {
  name: 'phased_pipeline_review',
  description: '分阶段流水线评审：读取、评级、汇总',
  phases: [{ title: 'Gather' }, { title: 'Grade' }, { title: 'Report' }],
}

phase('Gather')

const graded = await pipeline(
  args.files,
  async (file, original, index) => {
    // stage 1：读取并评级（结构化输出）
    return await agent(`评审文件 ${original}，给出评级`, {
      label: `评级 ${original}`,
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          grade: { type: 'string', enum: ['A', 'B', 'C'] },
          note: { type: 'string' },
        },
        required: ['file', 'grade'],
      },
    })
  },
  async (result, original, index) => {
    // stage 2：纯 JS 整形（不消耗 agent）
    return { seq: index + 1, ...result }
  }
)

phase('Report')

return await agent(
  '按评级从高到低输出评审报告：\n' + JSON.stringify(graded, null, 2),
  { label: '评审报告' }
)
