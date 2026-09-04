/**
 * workflow 运行时错误类型（移植自 pi-dynamic-workflows src/errors.ts 的最小集）
 */

export enum WorkflowErrorCode {
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  AGENT_FAILED = "AGENT_FAILED",
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode
  /** recoverable=true 的失败在 parallel/pipeline 中塌缩为 null，且可被重试 */
  readonly recoverable: boolean

  constructor(message: string, code: WorkflowErrorCode, options: { recoverable: boolean }) {
    super(message)
    this.name = "WorkflowError"
    this.code = code
    this.recoverable = options.recoverable
  }
}

/** 把任意抛出物包装为 WorkflowError；未知错误视为可恢复（网络抖动等） */
export function wrapError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error
  if (error instanceof Error && (error.name === "AbortError" || /\babort(?:ed)?\b/i.test(error.message))) {
    return new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new WorkflowError(message, WorkflowErrorCode.AGENT_FAILED, { recoverable: true })
}
