/**
 * 嵌套 workflow 血统注册表（B1 方案 / Docs/02_设计与说明/嵌套workflow的TUI显示可行性报告.md）
 *
 * 问题：嵌套 run（子代理会话内再调 workflow 工具）的快照 parentSessionId 是子代理会话 id，
 *       主会话 TUI 按 parentSessionId 过滤，嵌套树不可见。
 * 方案：server 进程内维护 agentSessionId -> rootSessionId 映射；嵌套 workflow 工具执行时
 *       查表拿到祖先主会话写进快照 rootSessionId 字段，TUI 侧放宽匹配（parent 或 root 命中即显示）。
 *
 * 生命周期：
 *  runWorkflow 执行期
 *   -> tool 层经 onAgentUpdate 拿到 record.sessionId（session 创建即回传，running 态已带）
 *   -> register：该子会话 -> 本 run 的 rootSessionId
 *   -> run 结束（finally，含完成/失败/中断）unregister，防长期泄漏
 *
 * 边界：
 *  - 进程内 Map，重启即失：丢失后 rootSessionId 回退 parentSessionId 自身（现状行为），不劣化
 *  - 多层嵌套层层透传 root（leaf 的 root 也是主会话），无需树形结构
 *  - 多路并发按子会话 id 为 key，天然不冲突
 *  - journal 回放的 agent 不重建会话（sessionId 不回填），不会被注册，无泄漏面
 */

const lineage = new Map<string, string>()

/** 注册：某 run 的一个 agent 子会话 -> 该 run 的祖先主会话（幂等，重复注册同值无害） */
export function registerAgentSession(agentSessionId: string, rootSessionId: string): void {
  lineage.set(agentSessionId, rootSessionId)
}

/** 注销一批 agent 子会话（run 结束清理；未注册的 id 忽略） */
export function unregisterAgentSessions(agentSessionIds: Iterable<string>): void {
  for (const id of agentSessionIds) lineage.delete(id)
}

/** 查询：会话若是某活跃 run 的 agent 子会话，返回其 root；否则 undefined */
export function lookupRootSessionId(sessionId: string): string | undefined {
  return lineage.get(sessionId)
}
