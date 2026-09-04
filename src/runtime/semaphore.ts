/**
 * 并发限制器（照搬 pi-dynamic-workflows src/workflow.ts createLimiter）
 */

/** 创建一个最多同时执行 limit 个任务的信号量 */
export function createLimiter(limit: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    active--
    queue.shift()?.()
  }
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      next()
    }
  }
}
