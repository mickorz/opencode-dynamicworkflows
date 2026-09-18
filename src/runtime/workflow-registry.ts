/**
 * Workflow Registry（P1）
 *
 * 目录约定：<项目>/.opencode-workflows/workflows/*.js
 * workflowId = meta.id ?? meta.name（与现有脚本格式零冲突）
 *
 * Schedule 只依赖 workflowId，不依赖文件名/LLM 判断（需求文档第 7 节）。
 */

import fs from "node:fs"
import path from "node:path"
import { parseWorkflowScript } from "./vm.js"

export interface RegisteredWorkflow {
  id: string
  name: string
  /** 脚本绝对/项目相对路径 */
  filePath: string
}

export function workflowsDir(directory: string): string {
  return path.join(directory, ".opencode-workflows", "workflows")
}

/** 扫描 workflows 目录；目录不存在返回空表 */
export function loadRegistry(directory: string): Map<string, RegisteredWorkflow> {
  const dir = workflowsDir(directory)
  const result = new Map<string, RegisteredWorkflow>()
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    const filePath = path.join(dir, entry.name)
    try {
      const script = fs.readFileSync(filePath, "utf-8")
      const { meta } = parseWorkflowScript(script)
      const id = meta.id ?? meta.name
      const existing = result.get(id)
      if (existing) {
        throw new Error(`workflowId "${id}" 重复：${existing.filePath} 与 ${filePath}（meta.id ?? meta.name 必须全局唯一）`)
      }
      result.set(id, { id, name: meta.name, filePath })
    } catch (error) {
      // 单文件解析失败：带文件名上抛根因（脚本非法就修脚本，不做防御跳过）
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`workflows 目录中 ${entry.name} 解析失败：${message}`)
    }
  }
  return result
}

/** 按 workflowId 读脚本原文；不存在抛 WORKFLOW_NOT_FOUND 语义错误 */
export function readWorkflowScript(directory: string, workflowId: string): string {
  const registry = loadRegistry(directory)
  const found = registry.get(workflowId)
  if (!found) {
    const known = Array.from(registry.keys()).join(", ") || "（目录为空或不存在）"
    throw new Error(`WORKFLOW_NOT_FOUND：未找到 workflowId "${workflowId}"（目录 ${workflowsDir(directory)}，已知 id：${known}）`)
  }
  return fs.readFileSync(found.filePath, "utf-8")
}
