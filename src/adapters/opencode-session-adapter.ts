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
 * schema 400 降级（P1-2，R-07）：
 *  网关不支持 json_schema（表现为 HTTP 400 / invalid_parameter，OpenCode 的
 *  json_schema 走 StructuredOutput 工具 + toolChoice required）时，
 *  自动改走「prompt 要求 JSON + 本地宽松解析 + 必填字段校验」，
 *  并通过 onStructuredDegrade 回调通知调用方（可观测）。
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
  /** 结构化输出降级回调（P1-2 可观测性） */
  onStructuredDegrade?: (info: { label: string; reason: string }) => void
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

/** 判断错误是否"疑似网关不支持 json_schema/工具强制"（400 族） */
function isSchemaUnsupported(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /4\s*0\s*0|bad[_ ]?request|invalid[_ ]?parameter|response_format|tool[_ ]?choice|unsupported/i.test(text)
}

/** 错误消息裁剪（降级日志可读性） */
function summarizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 160 ? `${text.slice(0, 160)}...` : text
}

/** 宽松 JSON 解析：直接 parse -> 剥代码围栏 -> 首尾大括号截取，全失败返回 undefined */
function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const attempts = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  if (fence) attempts.push(fence[1].trim())
  const firstBrace = trimmed.search(/[[{]/)
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"))
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1))
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // 尝试下一种
    }
  }
  return undefined
}

/** 轻量校验：顶层 required 字段存在（完整 JSON Schema 校验不做，降级路径够用） */
function validateRequired(parsed: unknown, schema: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
  const missing: string[] = []
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    for (const key of required) {
      if (typeof key === "string" && !(key in record)) missing.push(key)
    }
  } else if (required.length) {
    return required.map(String)
  }
  return missing
}

export class OpenCodeSessionAdapter implements AgentSessionRunner {
  private readonly client: PluginInput["client"]
  private readonly parentSessionId?: string
  private readonly defaultAgent: string
  private readonly onStructuredDegrade?: (info: { label: string; reason: string }) => void
  /** 本 run 内已确认网关不支持 json_schema：后续 schema 调用直接走降级，不再白发注定 400 的请求 */
  private formatUnsupported = false

  constructor(options: OpenCodeSessionAdapterOptions) {
    this.client = options.client
    this.parentSessionId = options.parentSessionId
    this.defaultAgent = options.defaultAgent ?? "explore"
    this.onStructuredDegrade = options.onStructuredDegrade
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
      const model = parseModelSpec(options?.model)

      if (options?.schema) {
        // 已确认不支持时跳过原生尝试，直接降级（消除每次必败的 400 噪音）
        if (this.formatUnsupported) {
          const label = options.label ?? prompt.slice(0, 30)
          this.onStructuredDegrade?.({ label, reason: "网关已知不支持 json_schema（本 run 内首次探测已确认）" })
          return await this.promptDegradedJson(sessionId, prompt, model, options, new Error("format unsupported (cached)"))
        }
        try {
          return await this.promptStructured(sessionId, prompt, model, options)
        } catch (error) {
          if (!isSchemaUnsupported(error)) throw error
          this.formatUnsupported = true
          const label = options.label ?? prompt.slice(0, 30)
          this.onStructuredDegrade?.({ label, reason: summarizeError(error) })
          return await this.promptDegradedJson(sessionId, prompt, model, options, error)
        }
      }
      return await this.promptText(sessionId, prompt, model, options)
    } finally {
      signal?.removeEventListener("abort", abortSession)
    }
  }

  /** 原生结构化路径：format: json_schema，结果取 info.structured */
  private async promptStructured(
    sessionId: string,
    prompt: string,
    model: { providerID: string; modelID: string } | undefined,
    options: AgentRunOptions,
  ): Promise<unknown> {
    // 注意：format 字段在当前 1.18.27 的旧版 gen 类型中缺失，但服务端已支持
    //（本地源码证据：session/prompt.ts:1499-1521 PromptInput.format；schema/src/v1/session.ts:65-79）
    const message = await this.execPrompt(
      sessionId,
      {
        model,
        agent: options.agentType ?? this.defaultAgent,
        parts: [{ type: "text", text: prompt }],
        format: { type: "json_schema", schema: options.schema },
      },
      options.directory,
    )
    this.emitUsage(message, options)
    return message.info.structured ?? null
  }

  /** 降级结构化路径：去掉 format，prompt 要求 JSON，本地宽松解析 + 必填校验（P1-2） */
  private async promptDegradedJson(
    sessionId: string,
    prompt: string,
    model: { providerID: string; modelID: string } | undefined,
    options: AgentRunOptions,
    originalError: unknown,
  ): Promise<unknown> {
    const schema = options.schema!
    const instructed =
      `${prompt}\n\n请只输出一个符合以下 JSON Schema 的 JSON 值，不要输出任何解释文字、Markdown 或代码围栏：\n` +
      JSON.stringify(schema)
    const message = await this.execPrompt(
      sessionId,
      {
        model,
        agent: options.agentType ?? this.defaultAgent,
        parts: [{ type: "text", text: instructed }],
      },
      options.directory,
    )
    this.emitUsage(message, options)

    const text = extractText(message)
    const parsed = parseJsonLoose(text)
    if (parsed === undefined) {
      throw new Error(
        `结构化降级失败：模型未返回可解析的 JSON（${summarizeError(text)}）；原始错误：${summarizeError(originalError)}`,
      )
    }
    const missing = validateRequired(parsed, schema)
    if (missing.length) {
      throw new Error(`结构化降级失败：缺少必填字段 ${missing.join(", ")}；原始错误：${summarizeError(originalError)}`)
    }
    return parsed
  }

  /** 普通文本路径 */
  private async promptText(
    sessionId: string,
    prompt: string,
    model: { providerID: string; modelID: string } | undefined,
    options?: AgentRunOptions,
  ): Promise<unknown> {
    const message = await this.execPrompt(
      sessionId,
      {
        model,
        agent: options?.agentType ?? this.defaultAgent,
        parts: [{ type: "text", text: prompt }],
      },
      options?.directory,
    )
    this.emitUsage(message, options)
    return extractText(message)
  }

  /** 统一执行 prompt：处理 response.error / info.error 两个失败面 */
  private async execPrompt(
    sessionId: string,
    body: Record<string, unknown>,
    directory?: string,
  ): Promise<PromptResponse> {
    const response = await this.client.session.prompt({
      path: { id: sessionId },
      body: body as never,
      query: directory ? { directory } : undefined,
    })
    if (response.error) {
      throw new Error(`session prompt 失败: ${JSON.stringify(response.error)}`)
    }
    const message = response.data as unknown as PromptResponse
    if (message.info.error) {
      throw new Error(`provider error: ${JSON.stringify(message.info.error)}`)
    }
    return message
  }

  private emitUsage(message: PromptResponse, options?: AgentRunOptions): void {
    const tokens = message.info.tokens
    if (tokens && options?.onUsage) {
      const input = tokens.input ?? 0
      const output = tokens.output ?? 0
      options.onUsage({ input, output, total: input + output + (tokens.reasoning ?? 0) })
    }
  }
}

function parseModelSpec(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const sep = model.indexOf("/")
  if (sep <= 0 || sep === model.length - 1) {
    throw new Error(`agent model 必须是 "provider/modelId" 格式，收到: ${model}`)
  }
  return { providerID: model.slice(0, sep), modelID: model.slice(sep + 1) }
}

function extractText(message: PromptResponse): string {
  return message.parts
    .filter((part) => part.type === "text" && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}
