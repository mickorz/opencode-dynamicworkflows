# 多模型编排与 schema 结构化使用文档补充需求

> 状态：已完成（2026-09-11）
> 背景诉求：使用者目前无法从 README 与教学文档中学到"如何用不同 model 编排"与"如何用 schema 约束返回"，只能读源码或踩坑。补齐后可快速按标准开发 workflow 脚本。

## 一、现状盘点（2026-09-11 实测）

| 文档 | model / tier 用法 | schema 用法 | 结论 |
|---|---|---|---|
| README.md | 无 | 仅"功能一览"1 行提及 `schema` 走 `format: json_schema`，无示例 | 缺 |
| Docs/getting-started.md | 0 处 | 0 处 | 缺 |
| Docs/how-to-guides.md | 0 处 | 0 处（现有 4 章：后台运行 / 断点续跑 / 质量 DSL / worktree） | 缺 |
| Docs/configuration.md | 0 处 | 0 处 | 缺（model-tiers.json 配置完全没写） |
| Docs/troubleshooting.md | 0 处 | 仅 1 条"schema 模式 400 换模型或去掉 schema" | 部分缺 |

结论：三大高频能力（多模型编排、tier 分层、schema 约束返回）在使用者文档里基本空白，只有源码注释和内部 Docs 有零散信息。

## 二、需求内容

### FR-1 how-to-guides 新增章节「使用不同模型编排」

- `model` 参数用法：`agent(prompt, { model: "provider/modelId" })`
- **必须写清的坑**：model 必须是 `"provider/modelId"` 完整格式（如 `biangfeng-gateway/glm-5.2`）；裸 `modelId` 会被 Adapter 拒绝并抛错（`opencode-session-adapter.ts` 的 `parseModelSpec`）
- `tier` 参数用法：`agent(prompt, { tier: "small" })`，优先级低于显式 model；未配置的 tier 回退会话默认模型并打告警
- tier 配置文件：全局 `~/.config/opencode/workflows/model-tiers.json` + 项目 `.opencode-workflows/model-tiers.json`（项目覆盖全局），示例：

```json
{ "tiers": { "small": "provider/cheap-model", "big": "provider/strong-model" } }
```

- 模型编排经验（弱模型干杂活、强模型干重活的分工模式，可引 xc-flow 的 fgui_design_detail 案例：杂活 flash、DSL 生成 5.2）

### FR-2 how-to-guides 新增章节「schema 结构化返回」

- schema 定义方式（JSON Schema 子集：type/properties/required）与 `agent(prompt, { schema })` 用法
- **返回值形态变化**：带 schema 时 `agent()` 返回结构化对象（字段可直接访问），不带 schema 返回字符串——同一 workflow 混用时注意判型
- 返回约束的意义：字段契约 + 必填校验，编排代码可以安全做 `if (result.ok)` 与字段访问，无需自己 JSON.parse 与防御
- 实现机制一句话：走 OpenCode `format: json_schema` 原生结构化输出（服务端注入 StructuredOutput 工具）
- 网关不支持 json_schema 时的自动降级行为（prompt 要求 JSON + 本地宽松解析 + 必填校验），使用者无需处理
- 失败语义：结构化失败抛错进入 retry/failed 流程，与普通 agent 一致

### FR-3 troubleshooting 新增 3 条

1. **带 schema 的节点点击进子会话正文空白**：说明这是结构化输出的正常形态（结果在 StructuredOutput 工具调用里，不在正文），结果可从 workflow 返回值 / journal 获取；详细定案链接到 `Docs/05_问题与注意事项/多模型编排agent详情内容为空问题-注意事项.md`（公开版可指向未来的 Node Detail 需求 `TUI节点详情与结果展示需求.md`）
2. **agent 报"model 必须是 provider/modelId 格式"**：补全 provider 前缀
3. **log 出现 tier 未配置告警**：检查 model-tiers.json 路径与键名

### FR-4 README 顺带补齐

- 「核心概念」或「5 分钟快速开始」加一个带 schema + 指定 model 的最小示例（10 行内）
- 「文档地图」表更新 how-to-guides 新章节入口

### FR-5 getting-started 结果章节一句话提及

- 运行示例后指一句："agent 可指定 model 与 schema 约束返回，见 how-to-guides"——入门文档不展开，只留入口

## 三、可直用的技术素材（写文档时直接取用，均已核实的代码事实）

| 事实 | 出处 |
|---|---|
| model 解析：必须有 `/`，裸 ID throw `"agent model 必须是 provider/modelId 格式"` | `src/adapters/opencode-session-adapter.ts` |
| 模型优先级：显式 model > tier（resolveTier）> 会话默认；tier 未配置回退并告警（每 tier 只告警一次） | `src/runtime/workflow-runtime.ts`、`src/agent/model-tiers.ts` |
| tier 配置路径与合并规则 | `src/agent/model-tiers.ts` 头注释 |
| schema 400 降级链：json_schema 失败 → prompt 要求 JSON + parseJsonLoose + required 校验；同 run 内命中一次后不再重试原生路径 | `src/adapters/opencode-session-adapter.ts`（P1-2/R-07 注释） |
| 空文本结果不回放：journal 中空串结果下次必重跑 | `src/runtime/workflow-runtime.ts` |
| schema 空白现象定案与实验数据 | `Docs/05_问题与注意事项/多模型编排agent详情内容为空问题-注意事项.md` |

## 四、验收标准

1. 不读源码、只看 README + how-to-guides 的新使用者，能独立写出带 `model` 与 `schema` 的 agent 调用并理解返回值类型差异
2. 遇到"节点空白 / model 格式错 / tier 告警"三类问题时，能从 troubleshooting 直接找到原因与动作
3. 文档中的示例代码全部与当前实现一致（model 格式、tier 路径、降级行为逐条对照源码核实）
4. 英文用户文档（docs/ 入库的 6 篇）与 README 同步更新；内部 Docs（不入库）不需要动

## 五、引用说明

- 实现事实来源：`src/runtime/workflow-runtime.ts`、`src/agent/model-tiers.ts`、`src/adapters/opencode-session-adapter.ts`
- schema 空白定案：`Docs/05_问题与注意事项/多模型编排agent详情内容为空问题-注意事项.md`、`Docs/01_需求与规划/TUI节点详情与结果展示需求.md`
- 现有文档基线：README.md、`Docs/getting-started.md`、`Docs/how-to-guides.md`、`Docs/configuration.md`、`Docs/troubleshooting.md`
- 实战案例：xc-flow 工程 `.opencode/skills/sdd/3-design/client/4-design-detail-client-fgui-skill/workflow/fgui_design_detail.js`（MODEL/MODEL_STRONG 双模型分工 + 全量 schema）
