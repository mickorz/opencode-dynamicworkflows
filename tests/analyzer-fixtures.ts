/**
 * P3 Analyzer 固定 Trace Fixtures
 *
 * 构造好的 AnalysisToolEvent[]，覆盖各类分析场景。
 * 不依赖 LLM 行为，保证规则测试的确定性。
 */

import type { AnalysisToolEvent } from "../src/development/analyzer/types.js"
import type { ToolCallEvent } from "../src/trace/collector.js"

/** 构造 AnalysisToolEvent 的辅助函数 */
function makeEvent(opts: {
  callID: string
  tool: string
  status?: ToolCallEvent["status"]
  input?: Record<string, unknown>
  output?: string
  error?: string
  startedAt?: number
  endedAt?: number
  agentId?: string
  agentLabel?: string
  sessionId?: string
  workflowScopePath?: string[]
  replayed?: boolean
  messageIndex?: number
  partIndex?: number
}): AnalysisToolEvent {
  return {
    callID: opts.callID,
    tool: opts.tool,
    messageID: `msg-${opts.callID}`,
    partID: `prt-${opts.callID}`,
    status: opts.status ?? "completed",
    input: opts.input ?? {},
    output: opts.output,
    error: opts.error,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    partIndex: opts.partIndex ?? 0,
    messageIndex: opts.messageIndex ?? 0,
    agentId: opts.agentId ?? "run-test:0",
    agentLabel: opts.agentLabel ?? "Agent A",
    sessionId: opts.sessionId ?? "sess-1",
    workflowScopePath: opts.workflowScopePath ?? ["root"],
    replayed: opts.replayed ?? false,
  }
}

export const FIXTURES = {
  /** 两次相同 read（触发 repeat Observation） */
  repeatSameRead: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "read",
      input: { filePath: "config.json" },
      output: '{"plugin": true}',
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "read",
      input: { filePath: "config.json" },
      output: '{"plugin": true}',
      startedAt: 2000,
      endedAt: 2100,
    }),
  ],

  /** 两次相同 write（触发 repeat Observation + script extraction） */
  repeatSameWrite: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "write",
      input: { filePath: "output.txt", content: "hello world" },
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "write",
      input: { filePath: "output.txt", content: "hello world" },
      startedAt: 2000,
      endedAt: 2100,
    }),
  ],

  /** error 后同 tool completed（触发 retry confirmed） */
  retryConfirmed: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "error",
      input: { command: "npm test" },
      error: "test failed",
      startedAt: 1000,
      endedAt: 1500,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "npm test" },
      output: "all passed",
      startedAt: 3000,
      endedAt: 4000,
    }),
  ],

  /** error 后同 tool 但参数不同（触发 retry possible） */
  retryPossible: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "error",
      input: { command: "npm run build" },
      error: "build error",
      startedAt: 1000,
      endedAt: 1500,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "npm run build --fix" },
      output: "fixed",
      startedAt: 3000,
      endedAt: 4000,
    }),
  ],

  /** write 后 read 同文件（触发 dependency） */
  writeReadDependency: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "write",
      input: { filePath: "data.json", content: '{"key":"value"}' },
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "read",
      input: { filePath: "data.json" },
      output: '{"key":"value"}',
      startedAt: 2000,
      endedAt: 2100,
    }),
  ],

  /** write 脚本后 bash 执行（触发 script extraction，determinism=likely） */
  scriptExtraction: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "write",
      input: {
        filePath: "validate.py",
        content: [
          "import json",
          "import sys",
          "",
          "def validate(config):",
          "    if not isinstance(config, dict):",
          "        return False",
          "    return 'plugin' in config",
          "",
          "if __name__ == '__main__':",
          "    with open(sys.argv[1], 'r') as f:",
          "        result = validate(json.load(f))",
          "    print('valid' if result else 'invalid')",
        ].join("\n"),
      },
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "python validate.py opencode.json" },
      output: "valid",
      startedAt: 2000,
      endedAt: 2500,
    }),
  ],

  /** bash heredoc 创建脚本（触发 script extraction from heredoc） */
  heredocScript: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "completed",
      input: {
        command: "cat <<'EOF' > check.py\nimport sys\nprint(sys.version)\nEOF",
      },
      output: "",
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "python check.py" },
      output: "3.12.0",
      startedAt: 2000,
      endedAt: 2500,
    }),
  ],

  /** 含 Date.now 的脚本（determinism=unlikely） */
  nondeterministicScript: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "write",
      input: {
        filePath: "timestamp.py",
        content: "import time\nprint(int(time.time()))",
      },
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "python timestamp.py" },
      output: "1718472000",
      startedAt: 2000,
      endedAt: 2500,
    }),
  ],

  /** 含网络调用的脚本（determinism=unknown） */
  networkScript: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "write",
      input: {
        filePath: "fetch.py",
        content: [
          "import requests",
          "result = requests.get('https://example.com/api')",
          "print(result.text)",
        ].join("\n"),
      },
      startedAt: 1000,
      endedAt: 1100,
    }),
    makeEvent({
      callID: "c2",
      tool: "bash",
      status: "completed",
      input: { command: "python fetch.py" },
      output: "OK",
      startedAt: 2000,
      endedAt: 2500,
    }),
  ],

  /** edit 工具片段（scriptContent 标记为片段，evidenceIntegrity=partial） */
  editFragment: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "edit",
      input: {
        filePath: "script.py",
        oldString: "print('hello')",
        newString: "print('hello world')",
      },
      startedAt: 1000,
      endedAt: 1100,
    }),
  ],

  /** 并行 Agent 的事件交叠（验证 latency 不跨 Agent） */
  parallelAgents: (): AnalysisToolEvent[] => [
    // Agent A 的事件
    makeEvent({
      callID: "a1",
      tool: "read",
      input: { filePath: "a.txt" },
      startedAt: 1000,
      endedAt: 1100,
      agentId: "run-test:0",
      agentLabel: "Agent A",
      sessionId: "sess-a",
    }),
    // Agent B 的事件（与 A 时间交叠）
    makeEvent({
      callID: "b1",
      tool: "read",
      input: { filePath: "b.txt" },
      startedAt: 1050,
      endedAt: 1150,
      agentId: "run-test:1",
      agentLabel: "Agent B",
      sessionId: "sess-b",
    }),
    // Agent A 的第二个事件
    makeEvent({
      callID: "a2",
      tool: "write",
      input: { filePath: "a-out.txt", content: "done" },
      startedAt: 1200,
      endedAt: 1300,
      agentId: "run-test:0",
      agentLabel: "Agent A",
      sessionId: "sess-a",
    }),
  ],

  /** 含大 gap 的 Agent（验证 latency Observation，gap > 5s） */
  latencyGap: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "read",
      input: { filePath: "input.txt" },
      startedAt: 1000,
      endedAt: 1100,
    }),
    // gap = 7000 - 1100 = 5900ms
    makeEvent({
      callID: "c2",
      tool: "write",
      input: { filePath: "output.txt", content: "result" },
      startedAt: 7000,
      endedAt: 7500,
    }),
  ],

  /** 同一 callID 多状态（验证 callID 去重：pending/running/completed 只保留最终态） */
  callIDStates: (): AnalysisToolEvent[] => [
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "pending",
      input: { command: "echo hello" },
      startedAt: 1000,
      messageIndex: 0,
      partIndex: 0,
    }),
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "running",
      input: { command: "echo hello" },
      startedAt: 1000,
      messageIndex: 0,
      partIndex: 1,
    }),
    makeEvent({
      callID: "c1",
      tool: "bash",
      status: "completed",
      input: { command: "echo hello" },
      output: "hello",
      startedAt: 1000,
      endedAt: 1500,
      messageIndex: 1,
      partIndex: 0,
    }),
  ],

  /** 空事件列表 */
  empty: (): AnalysisToolEvent[] => [],
}
