/**
 * Trace Collector —— session.messages() 返回值的解析层（P0 最小版）
 *
 * 职责：把 session.messages() 返回的原始消息数组解析为
 *       有序的工具调用事件序列，供 History Builder 消费。
 *
 * 纯函数，无 SDK 依赖，无 IO。宿主无关。
 * OpenCodeSessionAdapter 负责调 session.messages() 拿原始数据，
 * 本模块只消费结构化输入。
 *
 * 关键事实（schema/src/v1/session.ts:259-322）：
 *  - ToolPart.state.input 是 Record<String, Any>，不截断
 *    write 工具的 input.content 含完整脚本源码
 *    bash 工具的 input.command 含完整命令（含 heredoc 脚本）
 *  - ToolPart.state.output 是 String，经截断（2000 行 / 50KB）
 *    全文在 metadata.outputPath 指向的磁盘文件（7 天保留期）
 *  - 一次 session.prompt 产生多条 Assistant 消息（prompt.ts:1088 while 循环）
 *    每步模型执行创建一条新 Assistant 消息，ToolPart 分布在各条消息中
 *    不能只取最后一条，必须遍历全部消息
 */

/** 单次工具调用事件（从 ToolPart 提取） */
export interface ToolCallEvent {
  /** 工具调用的逻辑身份（同一调用的 pending->running->completed 共享 callID） */
  callID: string
  /** 工具名（write / bash / edit / read 等） */
  tool: string
  /** 所属消息 ID */
  messageID: string
  /** Part ID */
  partID: string
  /** 工具状态 */
  status: "pending" | "running" | "completed" | "error"
  /** 完整工具入参（不截断；write 的 content、bash 的 command 均在此） */
  input: Record<string, unknown>
  /** 截断后的输出预览（仅 completed/error 有） */
  output?: string
  /** 错误信息（仅 error 有） */
  error?: string
  /** 元数据（含 outputPath 指向磁盘全文） */
  metadata?: Record<string, unknown>
  /** 开始时间戳（毫秒） */
  startedAt?: number
  /** 结束时间戳（毫秒） */
  endedAt?: number
  /** 在消息中的序号（用于还原顺序） */
  partIndex: number
  /** 所属消息在全部消息中的序号 */
  messageIndex: number
}

/** session.messages() 返回的原始消息形状（与 OpenCode SDK 一致） */
export interface RawSessionMessage {
  info: {
    id: string
    role: "user" | "assistant"
  }
  parts: Array<{
    type: string
    id?: string
    callID?: string
    tool?: string
    state?: {
      status?: string
      input?: Record<string, unknown>
      output?: string
      error?: string
      metadata?: Record<string, unknown>
      title?: string
      time?: { start?: number; end?: number; compacted?: number }
    }
    // 非 tool Part 的字段（text / reason / cost / tokens 等），解析时按 type 过滤
    [key: string]: unknown
  }>
}

/**
 * 解析 session.messages() 返回值，提取有序工具调用事件。
 *
 * 遍历全部消息（不只 Assistant），提取 type === "tool" 的 Part，
 * 按 messageIndex + partIndex 排序，同一 callID 的多个状态都保留
 * （pending -> running -> completed 是同一调用的不同阶段）。
 *
 * 注意：一次 prompt 产生多条 Assistant 消息（prompt.ts:1088 while 循环），
 *       只取最后一条会漏大部分工具调用，必须遍历全部。
 */
export function parseSessionMessages(messages: RawSessionMessage[]): ToolCallEvent[] {
  const events: ToolCallEvent[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex]
    if (!msg.parts) continue
    for (let partIndex = 0; partIndex < msg.parts.length; partIndex++) {
      const part = msg.parts[partIndex]
      if (part.type !== "tool") continue
      const state = part.state ?? {}
      events.push({
        callID: part.callID ?? "",
        tool: part.tool ?? "",
        messageID: msg.info.id,
        partID: part.id ?? "",
        status: normalizeToolStatus(state.status),
        input: state.input ?? {},
        output: state.output,
        error: state.error,
        metadata: state.metadata,
        startedAt: state.time?.start,
        endedAt: state.time?.end,
        partIndex,
        messageIndex,
      })
    }
  }
  return events
}

/** 把服务端 status 字符串归一为联合类型，未知值兜底为 pending */
function normalizeToolStatus(status: string | undefined): ToolCallEvent["status"] {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "error":
      return status
    default:
      return "pending"
  }
}

/**
 * 按 callID 分组工具调用事件，取每个 callID 的最新状态。
 *
 * 用于「还原 Agent 最终做了什么」场景：
 * pending -> running -> completed 三条只保留最后一条（completed）。
 *
 * 与 parseSessionMessages 的区别：parseSessionMessages 保留全部状态流转，
 * 本函数折叠为每个 callID 一条最终态。
 */
export function dedupeByCallID(events: ToolCallEvent[]): ToolCallEvent[] {
  const byCallID = new Map<string, ToolCallEvent>()
  for (const event of events) {
    const prev = byCallID.get(event.callID)
    if (!prev || event.messageIndex > prev.messageIndex || event.partIndex > prev.partIndex) {
      byCallID.set(event.callID, event)
    }
  }
  return Array.from(byCallID.values())
}
