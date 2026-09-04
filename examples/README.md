# examples —— 插件测试工程

自包含的测试环境：不依赖 thirdparties（其不入库），克隆仓库即可完整跑通测试指南的全部步骤。

```
examples/sample-project/          # 测试工程（在这里启动 OpenCode，一切自包含）
├─ opencode.json                  # 已配好 plugin 与 skills.paths（相对路径指向上级仓库）
├─ docs/                          # 10 个标准验收集 mdx（拷贝自 OpenCode 官方文档，MIT）
└─ scripts/                       # 可直接让 Main Agent 读取执行的 workflow 脚本
   ├─ smoke-test.js               # 冒烟：3 个 agent
   ├─ acceptance-10docs.js        # 标准验收 A-01/A-02/A-03
   ├─ schema-test.js              # 结构化输出 A-07（P1 后经降级路径，验证 R-07）
   ├─ resume-test.js              # P1 journal/resume 首跑（续跑步骤见 Docs/P1测试指南.md）
   ├─ quality-dsl-test.js         # P1 质量 DSL：judgePanel + verify + checkpoint
   ├─ tier-fallback-test.js       # P1 tier 回退告警演示
   └─ worktree-test.js            # P1 worktree 隔离演示
```

## 使用步骤

1. 仓库根目录先构建插件：`npm install && npm run build`
2. 进入 `examples/sample-project`，启动 OpenCode
3. 问 Main Agent："你有哪些工具？"——确认有 workflow；"有哪些 skills？"——确认有 workflow-authoring
4. 执行测试脚本（Main Agent 自己读文件，无需粘贴）：

   ```
   读取 scripts/smoke-test.js 的内容，用 workflow 工具原样执行，不要改动脚本
   ```

   验收与结构化测试同理换成 `scripts/acceptance-10docs.js`、`scripts/schema-test.js`
5. 中断验证（A-08）：验收脚本分析进行中按 Esc，确认子会话全部停止

完整检查点清单见 `Docs/测试指南.md`（Docs 目录仅本地存在；其内嵌的脚本内容与本目录 scripts/ 一致）。

### 路径解析说明（已对照 OpenCode 源码验证）

- `plugin: ["../.."]`：相对**配置文件所在目录**解析（config/plugin.ts:49-53），指向仓库根，读 dist/index.js
- `skills.paths: ["../../skills"]`：相对 **OpenCode 启动目录**解析（skill/index.ts:215），指向仓库根/skills
- 两个基准在本目录启动时同为 examples/sample-project，因此 ../.. 一致指向仓库根；**只要在本目录启动即可，无需绝对路径**
- 脚本内的 `docs/xxx` 相对路径同样基于本启动目录，因此脚本必须放在本工程内执行

## 语料说明

docs/ 下 10 个 mdx 拷贝自 thirdparties/opencode/packages/web/src/content/docs 根目录按文件名排序的前 10 个英文文档（acp / agents / cli / commands / config / custom-tools / ecosystem / enterprise / formatters / github），MIT License，仅作测试语料。
