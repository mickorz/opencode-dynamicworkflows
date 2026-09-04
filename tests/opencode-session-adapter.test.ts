/**
 * OpenCodeSessionAdapter 测试（fake client，不发真实 HTTP）
 *
 * 覆盖（重点 P1-2 schema 400 降级）：
 *  - 文本路径：返回 text parts 拼接 + 用量回传
 *  - 原生结构化路径：info.structured 直接返回
 *  - 400 触发降级：去 format 的二次 prompt，JSON 围栏/裸文解析，必填校验
 *  - 降级解析失败：抛含原始错误的异常
 *  - 非 400 错误不降级，直接上抛
 *  - info.error（200 + provider error）同样触发降级
 *  - model 规格校验
 */

import test from "node:test"
import assert from "node:assert/strict"
import type { PluginInput } from "@opencode-ai/plugin"
import { OpenCodeSessionAdapter } from "../src/adapters/opencode-session-adapter.js"

type Client = PluginInput["client"]

/** 造 fake client：可注入 prompt 行为（按 body 是否带 format 分支） */
function makeClient(opts: {
  onFormatPresent: "error400" | "infoError" | "ok" | "error500"
  plainResponse: () => { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }
  prompts?: Array<Record<string, unknown>>
  sessionId?: string
}): Client {
  const prompts = opts.prompts ?? []
  const client = {
    session: {
      create: async () => ({ data: { id: opts.sessionId ?? "sess-1" }, error: undefined }),
      prompt: async (input: { body: Record<string, unknown> }) => {
        prompts.push(input.body)
        if (input.body.format) {
          if (opts.onFormatPresent === "error400") {
            return { data: undefined, error: { status: 400, message: "invalid_parameter_error: [Invalid request parameters.]" } }
          }
          if (opts.onFormatPresent === "error500") {
            return { data: undefined, error: { status: 500, message: "internal" } }
          }
          if (opts.onFormatPresent === "infoError") {
            return {
              data: {
                info: { error: { type: "api", name: "provider_bad_request", message: "400 invalid_parameter" } },
                parts: [],
              },
              error: undefined,
            }
          }
          return {
            data: { info: { structured: { native: true }, tokens: { input: 1, output: 2 } }, parts: [] },
            error: undefined,
          }
        }
        const { info, parts } = opts.plainResponse()
        return { data: { info, parts }, error: undefined }
      },
      abort: async () => ({ data: undefined, error: undefined }),
    },
  }
  return client as unknown as Client
}

const SCHEMA = {
  type: "object",
  properties: { topic: { type: "string" }, keyFields: { type: "array", items: { type: "string" } } },
  required: ["topic", "keyFields"],
}

test("文本路径：拼接 text parts 并回传用量", async () => {
  const client = makeClient({
    onFormatPresent: "ok",
    plainResponse: () => ({
      info: { tokens: { input: 10, output: 5, reasoning: 1 } },
      parts: [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段", ignored: false },
        { type: "tool", text: "工具调用不应出现" },
      ],
    }),
  })
  const usages: unknown[] = []
  const adapter = new OpenCodeSessionAdapter({ client })
  const result = await adapter.run("分析", { label: "t", onUsage: (u) => usages.push(u) })
  assert.equal(result, "第一段\n第二段")
  assert.deepEqual(usages, [{ input: 10, output: 5, total: 16 }])
})

test("原生结构化路径：info.structured 直接返回", async () => {
  const client = makeClient({ onFormatPresent: "ok", plainResponse: () => ({ info: {}, parts: [] }) })
  const adapter = new OpenCodeSessionAdapter({ client })
  const result = await adapter.run("分析", { schema: SCHEMA })
  assert.deepEqual(result, { native: true })
})

test("400 触发降级：二次请求去 format，围栏 JSON 解析成功且必填校验通过", async () => {
  const prompts: Array<Record<string, unknown>> = []
  const client = makeClient({
    onFormatPresent: "error400",
    prompts,
    plainResponse: () => ({
      info: { tokens: { input: 3, output: 4 } },
      parts: [{ type: "text", text: "前置废话\n```json\n{ \"topic\": \"配置\", \"keyFields\": [\"plugin\"] }\n```\n后置" }],
    }),
  })
  const degrades: Array<{ label: string; reason: string }> = []
  const adapter = new OpenCodeSessionAdapter({ client, onStructuredDegrade: (info) => degrades.push(info) })
  const result = await adapter.run("总结", { label: "结构化分析", schema: SCHEMA })

  assert.deepEqual(result, { topic: "配置", keyFields: ["plugin"] })
  assert.equal(prompts.length, 2, "应发生两次 prompt（原生失败 + 降级重试）")
  assert.ok(prompts[0].format, "第一次带 format")
  assert.equal("format" in prompts[1], false, "降级请求不带 format")
  assert.match(JSON.stringify(prompts[1].parts), /JSON Schema/)
  assert.equal(degrades.length, 1)
  assert.equal(degrades[0].label, "结构化分析")
  assert.match(degrades[0].reason, /400/)
})

test("降级后模型返回裸 JSON 文本（无围栏）也能解析", async () => {
  const client = makeClient({
    onFormatPresent: "error400",
    plainResponse: () => ({
      info: {},
      parts: [{ type: "text", text: '{ "topic": "裸", "keyFields": [] }' }],
    }),
  })
  const adapter = new OpenCodeSessionAdapter({ client })
  const result = await adapter.run("x", { schema: SCHEMA })
  assert.deepEqual(result, { topic: "裸", keyFields: [] })
})

test("降级解析失败：抛出含原始错误与模型输出的异常", async () => {
  const client = makeClient({
    onFormatPresent: "error400",
    plainResponse: () => ({ info: {}, parts: [{ type: "text", text: "我就是不输出 JSON" }] }),
  })
  const adapter = new OpenCodeSessionAdapter({ client })
  await assert.rejects(
    adapter.run("x", { schema: SCHEMA }),
    /结构化降级失败.*原始错误/s,
  )
})

test("降级结果缺必填字段：抛出缺失字段名", async () => {
  const client = makeClient({
    onFormatPresent: "error400",
    plainResponse: () => ({ info: {}, parts: [{ type: "text", text: '{ "topic": "有" }' }] }),
  })
  const adapter = new OpenCodeSessionAdapter({ client })
  await assert.rejects(adapter.run("x", { schema: SCHEMA }), /缺少必填字段 keyFields/)
})

test("同 run 内第二次 schema 调用直接降级，不再发原生尝试", async () => {
  const prompts: Array<Record<string, unknown>> = []
  let plainCalls = 0
  const client = makeClient({
    onFormatPresent: "error400",
    prompts,
    plainResponse: () => {
      plainCalls++
      return { info: {}, parts: [{ type: "text", text: '{ "topic": "t' + plainCalls + '", "keyFields": [] }' }] }
    },
  })
  const adapter = new OpenCodeSessionAdapter({ client })
  await adapter.run("x1", { schema: SCHEMA })
  await adapter.run("x2", { schema: SCHEMA })
  // 第一次：原生（带 format）+ 降级重试 = 2 次；第二次：直接降级 = 1 次
  assert.equal(prompts.length, 3, "第二次不再发注定 400 的原生请求")
  assert.equal(prompts.filter((p) => "format" in p).length, 1, "仅首次带 format")
})

test("非 400 错误不降级，直接上抛", async () => {
  const prompts: Array<Record<string, unknown>> = []
  const client = makeClient({ onFormatPresent: "error500", prompts, plainResponse: () => ({ info: {}, parts: [] }) })
  const adapter = new OpenCodeSessionAdapter({ client })
  await assert.rejects(adapter.run("x", { schema: SCHEMA }), /session prompt 失败.*500/)
  assert.equal(prompts.length, 1, "只发生一次 prompt，不重试")
})

test("info.error（200 + provider error）同样触发降级", async () => {
  const client = makeClient({
    onFormatPresent: "infoError",
    plainResponse: () => ({ info: {}, parts: [{ type: "text", text: '{ "topic": "t", "keyFields": ["k"] }' }] }),
  })
  const degrades: unknown[] = []
  const adapter = new OpenCodeSessionAdapter({ client, onStructuredDegrade: () => degrades.push(1) })
  const result = await adapter.run("x", { schema: SCHEMA })
  assert.deepEqual(result, { topic: "t", keyFields: ["k"] })
  assert.equal(degrades.length, 1)
})

test("model 规格校验：非 provider/modelId 形式报错", async () => {
  const client = makeClient({ onFormatPresent: "ok", plainResponse: () => ({ info: {}, parts: [] }) })
  const adapter = new OpenCodeSessionAdapter({ client })
  await assert.rejects(adapter.run("x", { model: "裸模型名" }), /provider\/modelId/)
})
