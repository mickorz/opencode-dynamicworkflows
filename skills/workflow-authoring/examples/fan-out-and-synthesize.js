// 范例：扇出汇总 —— 并行分析多个目标后用一个 agent 综合
// 输入经 args 注入，脚本内零硬编码（可确定性重放的要求）

export const meta = { name: 'fan_out_and_synthesize', description: '并行分析多个文件后综合汇总' }

phase('Scan')

// 第一个 agent 负责发现目标清单（也可以直接用 args.files 跳过这一步）
const targets = (args && args.files) || (await agent('列出 docs 目录下的 markdown 文件，每行一个路径'))

const files = String(targets).split('\n').map(s => s.trim()).filter(Boolean)

phase('Analyze')

const findings = await parallel(
  files.map(file => () =>
    agent(`分析 ${file} 的核心论点与风险，3 句话以内`, {
      label: `分析 ${file}`,
      schema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string' },
        },
        required: ['file', 'points'],
      },
    })
  )
)

phase('Synthesize')

// 综合调用用主模型（缺省即会话默认模型），只读分析
return await agent(
  '综合以下各文件分析，输出整体结论与跨文件风险：\n' + JSON.stringify(findings, null, 2),
  { label: '综合汇总' }
)
