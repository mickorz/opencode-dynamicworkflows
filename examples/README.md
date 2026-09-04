# examples —— 插件测试工程

自包含的测试环境：不依赖 thirdparties（其不入库），克隆仓库即可完整跑通测试指南的全部步骤。

```
examples/
├─ README.md                 # 本文件
├─ sample-project/           # 测试工程（在这里启动 OpenCode）
│  ├─ opencode.json          # 已配好 plugin 与 skills.paths（相对路径指向上级仓库）
│  └─ docs/                  # 10 个标准验收集 mdx（拷贝自 OpenCode 官方文档，MIT）
└─ scripts/                  # 可直接粘贴执行的 workflow 脚本
   ├─ smoke-test.js          # 冒烟：3 个 agent
   ├─ acceptance-10docs.js   # 标准验收 A-01/A-02/A-03
   └─ schema-test.js         # 结构化输出 A-07 + R-07 观察点
```

## 使用步骤

1. 仓库根目录先构建插件：`npm install && npm run build`
2. 进入 `examples/sample-project`，启动 OpenCode
3. 问 Main Agent："你有哪些工具？"——确认有 workflow；"有哪些 skills？"——确认有 workflow-authoring
   （若没有：opencode.json 里把 `../..` 换成本仓库绝对路径，重启 OpenCode）
4. 按测试指南逐步执行 scripts/ 下的脚本——对 Main Agent 说：
   "用 workflow 工具执行 examples/scripts/smoke-test.js 的内容，原样执行不要改动"
5. 中断验证（A-08）：验收脚本分析进行中按 Esc，确认子会话全部停止

完整检查点清单见 `Docs/测试指南.md`（注意：Docs 目录本地存在但未入库，脚本内容已内嵌在指南里）。

## 语料说明

docs/ 下 10 个 mdx 拷贝自 thirdparties/opencode/packages/web/src/content/docs 根目录按文件名排序的前 10 个英文文档（acp / agents / cli / commands / config / custom-tools / ecosystem / enterprise / formatters / github），MIT License，仅作测试语料。
