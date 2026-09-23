/**
 * Node Execution Contract（Composite Control Flow V1 的内部协议层）
 *
 * executeNode 的判定流程：
 *
 *  executeNode(node, input)
 *      ├─> 调用 node(input)
 *      ├─> resolve 任意值（含 null / false / {ok:false}）
 *      │       └─> status = success（执行态与业务结果分离：业务否决走脚本层判断）
 *      └─> reject
 *          ├─> wrapError 后 recoverable = false
 *          │       └─> 原样 rethrow（结构性错误：脚本 bug，禁止被组合节点吞掉）
 *          └─> 可恢复失败
 *              ├─> isAborted() = true  -> status = cancelled
 *              └─> 否则                 -> status = failure（可被 fallback 换候选）
 *
 * 组合节点（sequence/fallback）对状态的映射：
 *  success   -> 继续 / 采纳该候选
 *  failure   -> sequence 立即停止返回 null；fallback 尝试下一候选
 *  cancelled -> 向上抛 WORKFLOW_ABORTED（run 级中止面，与 agent() 中止语义一致）
 *
 * 边界（纯控制层）：本模块不创建 agent、不记 journal、不碰 token/semaphore/worktree，
 * 中止态经 isAborted 注入，保持宿主无关。
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { wrapError } from "./errors.js"

/** 节点执行状态（Runtime 执行态，非业务结果） */
export type NodeStatus = "success" | "failure" | "cancelled"

/** Composite 执行作用域（P1-3 局部中止面 + P2-3 观测链）：
 *  signal：race 等竞争节点为候选注入的独立 AbortSignal，经 AsyncLocalStorage 沿 await 链传播
 *  （含 child workflow 内部），agent 在调用点读当前作用域，胜出后 abort 仅取消兄弟，
 *  不影响 root 的 shared.signal / shared.aborted；
 *  compositePath：组合链 cmpN id 数组（纯展示用，不参与 journal 寻址） */
export interface CompositeScope {
  signal?: AbortSignal
  compositePath?: string[]
}

export const compositeScopeStorage = new AsyncLocalStorage<CompositeScope>()

/** 节点执行结果：组合层内部使用，不进入公开 API（agent() 返回值形态不变） */
export interface NodeExecutionResult<T = unknown> {
  status: NodeStatus
  value?: T
  error?: unknown
}

/** 组合节点的节点形态：接收上一步结果，返回任意值（或 throw 表达失败） */
export type WorkflowNode<TPrev = unknown, TResult = unknown> = (
  previous: TPrev,
) => TResult | Promise<TResult>

/**
 * 创建节点执行器。isAborted 由调用方注入（workflow-runtime 的中止面闭包），
 * 本函数不持有 SharedRunContext，保持模块宿主无关。
 */
export function createNodeExecutor(isAborted: () => boolean) {
  return async function executeNode(
    node: WorkflowNode,
    input: unknown,
  ): Promise<NodeExecutionResult> {
    let value: unknown
    try {
      value = await node(input)
      return { status: "success", value }
    } catch (error) {
      const workflowError = wrapError(error)
      // 结构性错误（脚本校验/超限/child 脚本 throw 等）原样上抛，不许被组合节点吞掉
      if (!workflowError.recoverable) throw error
      if (isAborted()) {
        return { status: "cancelled", error: workflowError }
      }
      return { status: "failure", error: workflowError }
    }
  }
}
