// 结构化输出验证脚本（A-07 + R-07 观察点）
// 用法：在 examples/sample-project 目录启动 OpenCode 后，让 Main Agent 原样执行本脚本

export const meta = { name: 'schema_test', description: '结构化输出验证' }

const report = await agent('阅读 docs/config.mdx，总结 OpenCode 配置体系的要点', {
  label: '结构化分析',
  schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '文档主题' },
      keyFields: { type: 'array', items: { type: 'string' }, description: '关键配置项' },
      fileCount: { type: 'number', description: '提到的配置文件数量' }
    },
    required: ['topic', 'keyFields']
  }
})
return report
