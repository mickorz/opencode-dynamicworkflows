# OpenCode Dynamic Workflows - AI 开发规则

本项目为 OpenCode v1 插件。任何 AI 编码代理在本仓库工作前必须遵守以下规则。

## 事实来源（Source of Truth）

- 目标版本：`@opencode-ai/plugin` **1.18.27**（peerDependencies 与 devDependencies 均锁定，不带 `^`）
- TypeScript、v1 插件 API
- API 权威参考（按顺序）：
  1. 本地 `thirdparties/opencode/packages/plugin/src/`（类型定义）
  2. 本地 `thirdparties/opencode/packages/sdk/`（SDK 客户端）
  3. 官方文档 `thirdparties/opencode/packages/web/src/content/docs/plugins.mdx`

## 禁止发明 API

API 在已安装的 `@opencode-ai/plugin` / `@opencode-ai/sdk` 类型中找不到，就不允许使用。
从 Claude Code / Pi / Codex / MCP 推断 API 同样禁止，除非存在明确的 OpenCode 等价物。

## v1 only，禁止 v2

- 禁止使用 v2 API：`Plugin.define`、`@opencode-ai/plugin/v2/*` 导入、`ctx.storage`、`session.next.*` 事件
- 禁止 v1/v2 混用

## 已核实 API 事实（防止跑偏，均有本地源码证据）

1. structured output 的 prompt body 字段名是 **`format`**（非 outputFormat），枚举 `"text" | "json_schema"`，结构化结果落在响应 `info.structured`（session/prompt.ts:1499-1521、schema/src/v1/session.ts:65-79）
2. v1 `PluginInput` **无 `storage` 字段**（plugin/src/index.ts:45-53）
3. v1 事件联合**无 `tool.*` 事件**；工具拦截走 Hooks 具名键 `tool.execute.before/after`
4. `session.create` 的 `directory` 是 **query 参数**不是 body 字段（middleware/workspace-routing.ts:87）
5. 主会话 abort **不级联** child session；需按 `packages/opencode/src/tool/task.ts:321-357` 的 addEventListener/removeEventListener 范式自行接线
6. tool 输出默认截断 2000 行 / 50KB（tool/truncate.ts:13-14），原文落盘，metadata 带 outputPath
7. `session.prompt` 支持 `agent` 参数；内置 `explore` 为只读分析型子代理，`general` 为通用型
8. v1 插件模块必须 **default export `{ server: Plugin }`**（plugin/shared.ts:272-302）
9. 插件 tool 执行无超时限制；`ToolContext.abort` 为 AbortSignal，Esc 中断会话会触发

## 架构约束

- OpenCode 特定 API 只允许出现在 `src/adapters/`、`src/plugin/`、`src/tools/`
- `src/runtime/` **禁止** import `@opencode-ai/plugin` / `@opencode-ai/sdk` / OpenCode client —— Runtime 必须宿主无关
- 正确链路：`runtime → AgentSessionRunner 接口 → OpenCodeSessionAdapter → client.session.*`
- 错误示例：`runtime 里直接调 ctx.client.session.create()`
- `src/index.ts` 保持薄层：只做依赖初始化与注册，不放业务逻辑
- child session 一律经 Adapter 创建；Adapter 之外禁止直接调用 `client.session.create`

## 版本策略

- 不自动升级 `@opencode-ai/plugin`；升级由人工操作
- 未显式迁移 v2 前不使用 v2 插件 API

## 测试

- node:test + tsx（与 pi-dynamic-workflows 的 53 个测试同框架）
- runtime 测试注入 fake runner（参考 `tests/` 现有模式：countingAgent / deferredAgent / deferred gate），不 mock HTTP
- worktree 相关测试跑真实 git（P1 引入时）

## 代码风格

- 注释与 Log 用中文，代码标识符用英文
- 禁止在代码中加入任何 Emoji 表情符号
- 文件编码 UTF-8
