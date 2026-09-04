/**
 * OpenCodeSessionAdapter —— 把 AgentSessionRunner 落到 OpenCode SDK 上
 *
 * 调用流程：
 *  run(prompt, options)
 *   -> client.session.create({ parentID, title: label })        创建子会话（挂到主会话下，TUI 可导航）
 *   -> client.session.prompt({ model, agent, parts, format })   同步长请求，响应体即最终 assistant 消息
 *        -> format: { type: "json_schema", schema }             原生结构化输出（服务端注入 StructuredOutput 工具）
 *        -> 结构化结果取 info.structured；文本结果取 parts 中 type=text 的 text
 *   -> options.onUsage(info.tokens)                              用量回传（F-07 metadata 的 token 数）
 *   -> options.signal abort -> client.session.abort(...)         级联取消（task.ts:321-357 范式）
 *
 * 本文件是 src/adapters/ 层 —— 全仓库唯一允许触碰 OpenCode SDK 的位置（AGENTS.md 架构约束）。
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRunOptions, AgentSessionRunner } from "../agent/session-runner.js"

export interface OpenCodeSessionAdapterOptions {
  /** 插件 context 提供的 SDK client */
  client: PluginInput["client"]
  /** 主会话 ID；创建的子会话挂在其下（TUI 父会话 subagent 视图可导航） */
  parentSessionId?: string
  /** 缺省使用的 OpenCode agent 名；默认 explore（内置只读分析型） */
  defaultAgent?: string
}

/** prompt 响应中我们实际消费的字段（server 端形状，见本地源码 session/prompt.ts:104-105、schema v1/session.ts:493-500） */
interface PromptResponse {
  info: {
    error?: unknown
    structured?: unknown
    tokens?: { input?: number; output?: number; reasoning?: number }
  }
  parts: Array<{ type: string; text?: string; ignored?: boolean }>
}

export class OpenCodeSessionAdapter implements AgentSessionRunner {
  private readonly client: PluginInput["client"]
  private readonly parentSessionId?: string
  private readonly defaultAgent: string

  constructor(options: OpenCodeSessionAdapterOptions) {
    this.client = options.client
    this.parentSessionId = options.parentSessionId
    this.defaultAgent = options.defaultAgent ?? "explore"
  }

  async run(prompt: string, options?: AgentRunOptions): Promise<unknown> {
    const created = await this.client.session.create({
      body: {
        parentID: this.parentSessionId,
        title: options?.label,
      },
    })
    if (created.error) {
      throw new Error(`session create 失败: ${JSON.stringify(created.error)}`)
    }
    const sessionId = created.data.id

    // abort 级联：signal 触发时取消这个子会话（照抄 task.ts 的接线范式，简化为单会话粒度）
    const abortSession = () => {
      void this.client.session.abort({ path: { id: sessionId } }).catch(() => {
        // 会话可能已结束；忽略取消失败
      })
    }
    const signal = options?.signal
    if (signal?.aborted) {
      abortSession()
      throw new Error("agent aborted before prompt")
    }
    signal?.addEventListener("abort", abortSession)

    try {
      // model 必须是 "provider/modelId"（OpenCode 惯例，如 anthropic/claude-sonnet-4-6）
      let model: { providerID: string; modelID: string } | undefined
      if (options?.model) {
        const sep = options.model.indexOf("/")
        if (sep <= 0 || sep === options.model.length - 1) {
          throw new Error(`agent model 必须是 "provider/modelId" 格式，收到: ${options.model}`)
        }
        model = { providerID: options.model.slice(0, sep), modelID: options.model.slice(sep + 1) }
      }

      // 注意：format 字段在当前 1.18.27 的旧版 gen 类型中缺失，但服务端已支持
      //（本地源码证据：session/prompt.ts:1499-1521 PromptInput.format；schema/src/v1/session.ts:65-79）
      const body = {
        model,
        agent: options?.agentType ?? this.defaultAgent,
        parts: [{ type: "text", text: prompt }],
        ...(options?.schema ? { format: { type: "json_schema", schema: options.schema } } : {}),
      }

      const response = await this.client.session.prompt({
        path: { id: sessionId },
        body: body as never,
      })
      if (response.error) {
        throw new Error(`session prompt 失败: ${JSON.stringify(response.error)}`)
      }
      const message = response.data as unknown as PromptResponse

      if (message.info.error) {
        throw new Error(`provider error: ${JSON.stringify(message.info.error)}`)
      }

      // 用量回传：tokens.total = input + output + reasoning
      const tokens = message.info.tokens
      if (tokens && options?.onUsage) {
        const input = tokens.input ?? 0
        const output = tokens.output ?? 0
        options.onUsage({ input, output, total: input + output + (tokens.reasoning ?? 0) })
      }

      // 结构化结果在 info.structured（prompt.ts:1288-1292 写入）；文本结果取 text parts
      if (options?.schema) {
        return message.info.structured ?? null
      }
      return message.parts
        .filter((part) => part.type === "text" && !part.ignored && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim()
    } finally {
      signal?.removeEventListener("abort", abortSession)
    }
  }
}
