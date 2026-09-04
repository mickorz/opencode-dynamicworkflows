/**
 * 插件入口（薄层，AGENTS.md 约束：只做依赖初始化与注册）
 *
 * 加载流程：
 *  opencode.json 的 plugin 配置指向本包
 *   -> readV1Plugin 读取 default export（必须是 { server: Plugin }，plugin/shared.ts:272-302）
 *        -> DynamicWorkflowPlugin(input)
 *             -> 注册 Hooks.tool.workflow
 *                  -> Main Agent 调用 workflow tool
 *                       -> runWorkflow -> OpenCodeSessionAdapter -> client.session.*
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createWorkflowTool } from "./tools/workflow.js"

export const DynamicWorkflowPlugin: Plugin = async (input) => {
  return {
    tool: {
      workflow: createWorkflowTool(input),
    },
  }
}

// 文件路径源插件的 default export 必须带 id（运行时强制：plugin/index.ts:117 + shared.ts:315，
// npm 源会回退 package.json name，文件源无回退；类型上 id 可选是假象）
export default { id: "opencode-dynamic-workflows", server: DynamicWorkflowPlugin } satisfies PluginModule
