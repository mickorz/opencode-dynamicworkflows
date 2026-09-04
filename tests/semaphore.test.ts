/**
 * 并发限制器测试（node:test，无框架依赖）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { createLimiter } from "../src/runtime/semaphore.js"

test("limiter 限制最大并发并在完成后放行队列", async () => {
  const limiter = createLimiter(2)
  let active = 0
  let maxActive = 0

  const task = async (ms: number, value: string) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, ms))
    active--
    return value
  }

  const results = await Promise.all([
    limiter(() => task(30, "a")),
    limiter(() => task(10, "b")),
    limiter(() => task(10, "c")),
    limiter(() => task(10, "d")),
    limiter(() => task(10, "e")),
  ])

  assert.equal(maxActive, 2)
  assert.deepEqual(results, ["a", "b", "c", "d", "e"])
})
