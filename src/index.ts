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

export default { server: DynamicWorkflowPlugin } satisfies PluginModule
