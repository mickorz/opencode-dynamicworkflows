/**
 * Trace 类型定义（P1）
 *
 * TraceManifest：Run 的采集清单，落盘为 manifest.json
 * SessionManifestEntry：单个 Session 的采集明细
 * TraceProvenance：回放 agent 的来源关联
 *
 * 宿主无关：不依赖 @opencode-ai/plugin / @opencode-ai/sdk
 */

/** Run 的采集清单（manifest.json 的形状） */
export interface TraceManifest {
  version: 1
  runId: string
  /** 区分同一 runId 的不同执行轮次（Resume 场景） */
  runAttemptId: string
  /** 根 Run ID（嵌套子 Run 归属） */
  rootRunId: string
  parentRunId?: string
  startedAt: number
  endedAt: number
  status: "completed" | "failed" | "aborted"
  /** 采集完整性 */
  completeness: "full" | "partial" | "failed"
  /** P2: 是否开启 Development 模式 */
  development?: boolean
  /** 触发来源（manual / schedule / development-optimizer） */
  trigger?: { type: string; scheduleId?: string; scheduledAt?: string }
  /** P4-0 契约一：顶层 Workflow 脚本溯源（Patch 资格与基线校验依据） */
  workflowSource?: WorkflowSource
  /** 各 Session 的采集明细 */
  sessions: SessionManifestEntry[]
}

/**
 * P4-0 契约一（Workflow Source Provenance）：顶层 Workflow 脚本溯源。
 *
 * 仅 kind=file 且路径可读、哈希可校验的 Workflow 具备自动 Patch 资格；
 * 内联脚本只产出优化建议（P4 执行文档 4.0.1）。
 */
export interface WorkflowSource {
  kind: "file" | "inline"
  /** 脚本文件的绝对路径（kind=file 时必有） */
  scriptPath?: string
  /** 顶层脚本原文 sha256（kind=file 时等于文件字节哈希，应用前基线校验对齐此值） */
  scriptHash: string
  /** 是否在 git 跟踪中（P4-C worktree 隔离需要；缺省未探测） */
  gitTracked?: boolean
  /** 脚本文件所在 git commit（缺省未探测） */
  gitCommit?: string
}

/** 单个 Session 的采集记录 */
export interface SessionManifestEntry {
  sessionId: string
  agentLabel: string
  agentId: string
  /** 所属子 Workflow 的 scopePath */
  workflowScopePath?: string[]
  /** 事件数 */
  eventCount: number
  /** 是否为 Journal 回放（无新 session） */
  replayed: boolean
  /** 回放来源（replayed=true 时指向原始执行） */
  sourceRunAttemptId?: string
  sourceSessionId?: string
  /** 输出完整性 */
  outputIntegrity: "full" | "truncated-only" | "missing" | "unavailable"
  /** 采集错误（拉取失败时记录原因） */
  collectionError?: string
}

/** 回放 agent 的来源关联（HistoryBuilder 消费） */
export interface TraceProvenance {
  /** 原始执行的 runAttemptId */
  sourceRunAttemptId: string
  /** 原始 session ID */
  sourceSessionId: string
  /** 原始 Trace 是否仍存在于磁盘 */
  available: boolean
}
