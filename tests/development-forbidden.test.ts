/**
 * developmentForbidden 防递归测试（P2）
 *
 * 验证 run-lineage.ts 的 developmentForbidden Map：
 *  - register + lookup：标记会话能查到
 *  - 未标记会话返回 false
 *  - unregister 清理
 *  - 嵌套透传：祖先有标记则继承
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  registerAgentSession,
  unregisterAgentSessions,
  lookupRootSessionId,
  registerDevelopmentForbidden,
  lookupDevelopmentForbidden,
} from "../src/tools/run-lineage.js"

test("register + lookup：标记会话能查到 developmentForbidden", () => {
  const sid = "ses-forbidden-test-1"
  const root = "ses-root-1"
  registerAgentSession(sid, root)
  registerDevelopmentForbidden(sid)
  assert.equal(lookupDevelopmentForbidden(sid), true)
  unregisterAgentSessions([sid])
})

test("未标记会话返回 false", () => {
  const sid = "ses-normal-test-2"
  const root = "ses-root-2"
  registerAgentSession(sid, root)
  assert.equal(lookupDevelopmentForbidden(sid), false)
  unregisterAgentSessions([sid])
})

test("unregister 清理 developmentForbidden 标记", () => {
  const sid = "ses-cleanup-test-3"
  const root = "ses-root-3"
  registerAgentSession(sid, root)
  registerDevelopmentForbidden(sid)
  assert.equal(lookupDevelopmentForbidden(sid), true)
  unregisterAgentSessions([sid])
  assert.equal(lookupDevelopmentForbidden(sid), false)
})

test("嵌套透传：祖先 rootSession 有标记则继承", () => {
  // 模拟 Optimizer Run：root session 标记 developmentForbidden
  const rootSid = "ses-optimizer-root-4"
  const agentSid = "ses-optimizer-agent-4"
  // agent 子会话注册到 root
  registerAgentSession(agentSid, rootSid)
  // root session 本身标记 developmentForbidden
  registerDevelopmentForbidden(rootSid)
  // agent 子会话查表应继承
  assert.equal(lookupDevelopmentForbidden(agentSid), true)
  // root session 自身也查到
  assert.equal(lookupDevelopmentForbidden(rootSid), true)
  unregisterAgentSessions([rootSid, agentSid])
})

test("嵌套未标记：祖先无标记则不继承", () => {
  const rootSid = "ses-normal-root-5"
  const agentSid = "ses-normal-agent-5"
  registerAgentSession(agentSid, rootSid)
  // root session 未标记
  assert.equal(lookupDevelopmentForbidden(agentSid), false)
  assert.equal(lookupDevelopmentForbidden(rootSid), false)
  unregisterAgentSessions([rootSid, agentSid])
})

test("未注册的会话查表返回 false", () => {
  assert.equal(lookupDevelopmentForbidden("ses-never-registered-6"), false)
})

test("幂等注册：重复标记同值无害", () => {
  const sid = "ses-idempotent-7"
  const root = "ses-root-7"
  registerAgentSession(sid, root)
  registerDevelopmentForbidden(sid)
  registerDevelopmentForbidden(sid) // 重复
  assert.equal(lookupDevelopmentForbidden(sid), true)
  unregisterAgentSessions([sid])
})

test("lookupRootSessionId 基本功能不回归", () => {
  const sid = "ses-lineage-test-8"
  const root = "ses-lineage-root-8"
  registerAgentSession(sid, root)
  assert.equal(lookupRootSessionId(sid), root)
  assert.equal(lookupRootSessionId("ses-unknown-8"), undefined)
  unregisterAgentSessions([sid])
})
