/**
 * TraceStore 单元测试（P1）
 *
 * 验证文件持久化的读写 roundtrip：
 *  - writeSessionTrace + readSessionTrace roundtrip
 *  - writeManifest + readManifest roundtrip
 *  - hasSessionTrace 判定
 *  - 不存在的 runId 读回空
 *  - writeHistory + writeHistoryMd 落盘
 *  - 落盘失败不抛错（只读目录降级）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, chmodSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TraceStore } from "../src/trace/store.js"
import type { ToolCallEvent } from "../src/trace/collector.js"
import type { TraceManifest } from "../src/trace/types.js"

/** 创建临时项目目录 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-store-test-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 构造测试用 ToolCallEvent */
function makeEvent(callID: string, tool: string, ts: number): ToolCallEvent {
  return {
    callID,
    tool,
    messageID: "msg-1",
    partID: `prt-${callID}`,
    status: "completed",
    input: { filePath: `test-${callID}.ts` },
    output: "ok",
    startedAt: ts,
    endedAt: ts + 100,
    partIndex: 0,
    messageIndex: 0,
  }
}

/** 构造测试用 TraceManifest */
function makeManifest(runId: string): TraceManifest {
  return {
    version: 1,
    runId,
    runAttemptId: `${runId}:abc123`,
    rootRunId: runId,
    startedAt: 1000,
    endedAt: 2000,
    status: "completed",
    completeness: "full",
    sessions: [
      {
        sessionId: "ses-a",
        agentLabel: "reader",
        agentId: "run-abc:0",
        eventCount: 2,
        replayed: false,
        outputIntegrity: "full",
      },
    ],
  }
}

test("writeSessionTrace + readSessionTrace roundtrip：写入后能读回，JSONL 格式正确", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    const events = [makeEvent("call-1", "read", 1000), makeEvent("call-2", "write", 2000)]

    store.writeSessionTrace("run-test", "ses-a", events)
    const read = store.readSessionTrace("run-test", "ses-a")

    assert.equal(read.length, 2)
    assert.equal(read[0].callID, "call-1")
    assert.equal(read[0].tool, "read")
    assert.equal(read[1].callID, "call-2")
    assert.equal(read[1].tool, "write")
  })
})

test("writeSessionTrace + readSessionTrace：空事件数组写出空文件，读回空数组", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    store.writeSessionTrace("run-test", "ses-empty", [])
    const read = store.readSessionTrace("run-test", "ses-empty")
    assert.deepEqual(read, [])
  })
})

test("writeManifest + readManifest roundtrip：manifest JSON 结构完整", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    const manifest = makeManifest("run-manifest")
    store.writeManifest("run-manifest", manifest)
    const read = store.readManifest("run-manifest")

    assert.notEqual(read, null)
    assert.equal(read!.runId, "run-manifest")
    assert.equal(read!.runAttemptId, "run-manifest:abc123")
    assert.equal(read!.completeness, "full")
    assert.equal(read!.sessions.length, 1)
    assert.equal(read!.sessions[0].sessionId, "ses-a")
    assert.equal(read!.sessions[0].agentLabel, "reader")
  })
})

test("hasSessionTrace：文件存在返回 true，不存在返回 false", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    store.writeSessionTrace("run-test", "ses-a", [makeEvent("c1", "read", 1000)])

    assert.equal(store.hasSessionTrace("run-test", "ses-a"), true)
    assert.equal(store.hasSessionTrace("run-test", "ses-b"), false)
    assert.equal(store.hasSessionTrace("run-other", "ses-a"), false)
  })
})

test("不存在的 runId 读回空：readSessionTrace 返回空数组，readManifest 返回 null", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    assert.deepEqual(store.readSessionTrace("nonexistent", "ses-x"), [])
    assert.equal(store.readManifest("nonexistent"), null)
  })
})

test("writeHistory + writeHistoryMd：文件落盘且内容正确", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    const jsonl = '{"type":"workflow_start","ts":1000}\n{"type":"workflow_end","ts":2000}'
    const md = "# Workflow History: run-xyz\n\n- Status: completed"

    store.writeHistory("run-xyz", jsonl)
    store.writeHistoryMd("run-xyz", md)

    const jsonlPath = join(store.runDir("run-xyz"), "history.jsonl")
    const mdPath = join(store.runDir("run-xyz"), "history.md")

    assert.equal(existsSync(jsonlPath), true)
    assert.equal(existsSync(mdPath), true)
    assert.equal(readFileSync(jsonlPath, "utf8"), jsonl)
    assert.equal(readFileSync(mdPath, "utf8"), md)
  })
})

test("runDir：返回正确的路径", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    const runDir = store.runDir("run-abc")
    assert.ok(runDir.includes("history"))
    assert.ok(runDir.includes("run-abc"))
  })
})

test("覆写：同一 runId + sessionId 多次写入，后者覆写前者", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    const events1 = [makeEvent("call-1", "read", 1000)]
    const events2 = [makeEvent("call-2", "write", 2000), makeEvent("call-3", "bash", 3000)]

    store.writeSessionTrace("run-test", "ses-a", events1)
    store.writeSessionTrace("run-test", "ses-a", events2)

    const read = store.readSessionTrace("run-test", "ses-a")
    assert.equal(read.length, 2)
    assert.equal(read[0].callID, "call-2")
    assert.equal(read[1].callID, "call-3")
  })
})

test("多 session：同一 runId 下多个 session 各自独立", () => {
  withTempDir((dir) => {
    const store = new TraceStore(dir)
    store.writeSessionTrace("run-test", "ses-a", [makeEvent("c1", "read", 1000)])
    store.writeSessionTrace("run-test", "ses-b", [makeEvent("c2", "write", 2000), makeEvent("c3", "bash", 3000)])

    assert.equal(store.readSessionTrace("run-test", "ses-a").length, 1)
    assert.equal(store.readSessionTrace("run-test", "ses-b").length, 2)
  })
})
