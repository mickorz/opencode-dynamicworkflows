/**
 * 插件入口（薄层，AGENTS.md 约束：只做依赖初始化与注册）
 *
 * 加载流程：
 *  opencode.json 的 plugin 配置指向本包
 *   -> readV1Plugin 读取 default export（必须是 { id, server: Plugin }，plugin/shared.ts:272-302）
 *        -> DynamicWorkflowPlugin(input)
 *             -> 创建 BackgroundRunManager 单例（跨 tool 调用共享后台 run 注册表）
 *             -> 注册 Hooks.tool.workflow 与 Hooks.tool.workflow_control
 *                  -> Main Agent 调用 workflow tool
 *                       -> 前台：阻塞执行返回结果
 *                       -> 后台：manager.start 立即返回 runId，完成后结果回传主会话
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createWorkflowTool } from "./tools/workflow.js"
import { createWorkflowControlTool } from "./tools/workflow-control.js"
import { BackgroundRunManager } from "./tools/background-runs.js"

export const DynamicWorkflowPlugin: Plugin = async (input) => {
  const background = new BackgroundRunManager()
  return {
    tool: {
      workflow: createWorkflowTool(input, background),
      workflow_control: createWorkflowControlTool(background),
    },
  }
}

// 文件路径源插件的 default export 必须带 id（运行时强制：plugin/index.ts:117 + shared.ts:315 抛错，
// npm 源会回退 package.json name，文件源无回退；类型上 id 可选是假象）
export default { id: "opencode-dynamic-workflows", server: DynamicWorkflowPlugin } satisfies PluginModule
