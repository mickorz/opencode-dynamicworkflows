/**
 * 插件模块形状测试 —— 防 "must export id" 这类加载期失败
 *
 * 背景：文件路径源插件的 default export 运行时强制要求 id 字段
 * （plugin/index.ts:117 applyPlugin -> resolvePluginId -> shared.ts:315 抛错），
 * 但 PluginModule 类型里 id 是可选的，类型检查抓不住，只能靠本测试兜底。
 */

import test from "node:test"
import assert from "node:assert/strict"
import pluginModule, { DynamicWorkflowPlugin } from "../src/index.js"

test("插件 default export 形状满足 v1 加载器要求", () => {
  assert.ok(pluginModule && typeof pluginModule === "object", "default export 必须是对象")
  assert.equal(typeof pluginModule.id, "string", "file 源插件必须导出非空 id（shared.ts:315）")
  assert.ok(pluginModule.id.trim().length > 0, "id 不能为空串")
  assert.equal(typeof pluginModule.server, "function", "default.server 必须是 Plugin 函数")
  assert.equal(pluginModule.tui, undefined, "server 与 tui 不能同时存在")
})

test("命名导出 DynamicWorkflowPlugin 是 Plugin 函数", () => {
  assert.equal(typeof DynamicWorkflowPlugin, "function")
})
