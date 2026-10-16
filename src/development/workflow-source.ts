/**
 * WorkflowSource 溯源计算（P4-0 契约一：Workflow Source Provenance）
 *
 * 类头流程图：
 *
 *  workflow 工具 execute 入口
 *        |
 *        v
 *  resolveScriptText 解析脚本文本
 *    kind=file  scriptPath 读盘（哈希等于文件字节，应用前基线校验对齐）
 *    kind=inline 脚本原文
 *        |
 *        v
 *  computeWorkflowSource
 *    判定 kind + 解析绝对路径 + sha256
 *        |
 *        v
 *  finalizeRun 写入 TraceManifest.workflowSource
 *        |
 *        v
 *  P4-A 聚合 / P4-B Patch 定位消费
 *
 * 约束（P4 执行文档 4.0.1）：
 *  - 仅 kind=file 且路径可读、哈希可校验的 Workflow 具备自动 Patch 资格
 *  - 两个 Run 产生相同脚本也可能来自不同 Workflow，Patch 按目标 Workflow 分离
 *  - gitTracked / gitCommit 由 P4-C worktree 场景补充探测，此处不填
 *  - 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { WorkflowSource } from "../trace/types.js"

/** 文本 sha256（utf8） */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** workflow 工具的脚本入参形态（与 script-source.ts 的 ScriptSourceInput 一致） */
interface ScriptSourceLike {
  script?: unknown
  scriptPath?: unknown
}

/**
 * 从工具入参计算顶层脚本溯源信息
 *
 * @param input workflow 工具原始入参（判定 kind 与路径）
 * @param cwd 项目目录（相对 scriptPath 的解析基准，与 resolveScriptText 一致）
 * @param resolvedScript resolveScriptText 返回的脚本文本（kind=file 时等于文件字节）
 */
export function computeWorkflowSource(input: ScriptSourceLike, cwd: string, resolvedScript: string): WorkflowSource {
  const hasPath = typeof input.scriptPath === "string" && input.scriptPath.trim().length > 0
  const source: WorkflowSource = {
    kind: hasPath ? "file" : "inline",
    scriptHash: sha256Text(resolvedScript),
  }
  if (hasPath) {
    const raw = (input.scriptPath as string).trim()
    source.scriptPath = isAbsolute(raw) ? raw : resolve(cwd, raw)
  }
  return source
}
