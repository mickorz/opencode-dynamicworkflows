/**
 * 血统注册表测试（B1 嵌套显示 / src/tools/run-lineage.ts）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  lookupRootSessionId,
  registerAgentSession,
  unregisterAgentSessions,
} from "../src/tools/run-lineage.js"

test("基本语义：注册后可查，注销后查不到", () => {
  registerAgentSession("ses_agent_a", "ses_root")
  assert.equal(lookupRootSessionId("ses_agent_a"), "ses_root")
  assert.equal(lookupRootSessionId("ses_unknown"), undefined)
  unregisterAgentSessions(["ses_agent_a"])
  assert.equal(lookupRootSessionId("ses_agent_a"), undefined)
})

test("幂等注册同值无害；注销未注册 id 忽略", () => {
  registerAgentSession("ses_agent_b", "ses_root")
  registerAgentSession("ses_agent_b", "ses_root")
  assert.equal(lookupRootSessionId("ses_agent_b"), "ses_root")
  unregisterAgentSessions(["ses_not_exist"])
  assert.equal(lookupRootSessionId("ses_agent_b"), "ses_root")
  unregisterAgentSessions(["ses_agent_b"])
})

test("多层嵌套层层透传 root：middle 与 leaf 的子会话都指向同一主会话", () => {
  registerAgentSession("ses_agent_middle", "ses_main")
  registerAgentSession("ses_agent_leaf1", "ses_main")
  registerAgentSession("ses_agent_leaf2", "ses_main")
  assert.equal(lookupRootSessionId("ses_agent_middle"), "ses_main")
  assert.equal(lookupRootSessionId("ses_agent_leaf1"), "ses_main")
  unregisterAgentSessions(["ses_agent_middle", "ses_agent_leaf1", "ses_agent_leaf2"])
  assert.equal(lookupRootSessionId("ses_agent_middle"), undefined)
})

test("一个子会话只属于一个 run：后注册覆盖先注册（重跑同会话场景）", () => {
  registerAgentSession("ses_agent_c", "ses_root1")
  registerAgentSession("ses_agent_c", "ses_root2")
  assert.equal(lookupRootSessionId("ses_agent_c"), "ses_root2")
  unregisterAgentSessions(["ses_agent_c"])
})
