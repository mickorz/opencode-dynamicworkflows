/**
 * AgentSessionRunner —— Runtime 与 OpenCode 之间的最小注入缝
 *（与 pi-dynamic-workflows 的 WorkflowAgentRunner 同构，workflow.ts:166-168）
 *
 * 依赖方向：
 *  src/runtime/（禁止 import opencode 包）
 *   -> AgentSessionRunner 接口（本文件，无任何 OpenCode 依赖）
 *        -> OpenCodeSessionAdapter 实现（src/adapters/）
 *             -> @opencode-ai/plugin 的 client.session.*
 *
 *  测试在接口处注入 fake runner（countingAgent / deferredAgent 模式），
 *  与 Pi 的 53 个 node:test 测试同一套路。
 */

import type { AgentUsage } from "../types/index.js"

/** 传给 Adapter 的单次 agent 调用选项（runtime 组装，脚本不直接可见） */
export interface AgentRunOptions {
  label?: string
  phase?: string
  /** OpenCode agent 名（explore / general / 自定义） */
  agentType?: string
  /** "provider/modelId" 或裸 "modelId" */
  model?: string
  /** JSON Schema 对象；存在时走 OpenCode 原生 format: json_schema */
  schema?: Record<string, unknown>
  /** 本 attempt 的取消信号（run 级 abort 或本 agent 超时触发） */
  signal?: AbortSignal
  /** 会话路由目录（worktree 隔离时指向 worktree 路径，经 query.directory 路由，P1-5） */
  directory?: string
  /** Adapter 从 prompt 响应提取用量后回调 */
  onUsage?: (usage: AgentUsage) => void
}

/** 最小 runner 接口：Runtime 只认这个形状 */
export interface AgentSessionRunner {
  run(prompt: string, options?: AgentRunOptions): Promise<unknown>
}
