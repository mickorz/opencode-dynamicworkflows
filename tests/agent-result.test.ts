/**
 * 结果展示助手测试（Node Inspector FR-5：截断 / 脱敏 / 预览构建）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildOutputPreview,
  truncatePromptForJournal,
  truncateUtf8ByBytes,
  redactValue,
  OUTPUT_PREVIEW_LIMIT_BYTES,
} from "../src/runtime/agent-result.js"

test("truncateUtf8ByBytes：中文与 emoji 截断不产生半个字符", () => {
  // 中文每字 3 字节：截 7 字节应保留 2 个完整汉字（6 字节）而非 2 个汉字 + 1 字节残缺
  const text = "你好世界测试"
  const cut = truncateUtf8ByBytes(text, 7)
  assert.equal(cut, "你好")
  assert.ok(!cut.includes("�"))
  // emoji 是 4 字节：截 6 字节保留一个完整 emoji（4 字节）
  const emoji = "😀😀😀"
  const cutEmoji = truncateUtf8ByBytes(emoji, 6)
  assert.equal(cutEmoji, "😀")
  assert.ok(!cutEmoji.includes("�"))
  // 未超预算原样返回
  assert.equal(truncateUtf8ByBytes("short", 100), "short")
  assert.equal(truncateUtf8ByBytes("abc", 0), "")
})

test("redactValue：敏感键打码，普通键与嵌套结构保留", () => {
  const input = {
    api_key: "sk-123",
    token: "tk",
    password: "pw",
    authorization: "Bearer x",
    secret: "s",
    my_credential: "c",
    nested: { safe: "可见", API_KEY: "inner" },
    list: [{ user_token: "t" }, { name: "普通" }],
  }
  const out = redactValue(input) as Record<string, unknown>
  for (const key of ["api_key", "token", "password", "authorization", "secret", "my_credential"]) {
    assert.equal(out[key], "[REDACTED]")
  }
  const nested = out.nested as Record<string, unknown>
  assert.equal(nested.safe, "可见")
  assert.equal(nested.API_KEY, "[REDACTED]", "大小写不敏感命中")
  const list = out.list as Array<Record<string, unknown>>
  assert.equal(list[0].user_token, "[REDACTED]")
  assert.equal(list[1].name, "普通")
})

test("redactValue：深度 4 截止，超深原样保留；数组 cap 50", () => {
  const deep = { a: { b: { c: { d: { secret: "深层不脱敏（超深返回原值）" } } } } }
  const out = redactValue(deep) as Record<string, unknown>
  const level3 = ((out.a as Record<string, unknown>).b as Record<string, unknown>).c as Record<string, unknown>
  const level4 = level3.d as Record<string, unknown>
  assert.equal(level4.secret, "深层不脱敏（超深返回原值）")

  const bigArray = Array.from({ length: 80 }, (_, i) => ({ v: i }))
  const capped = redactValue(bigArray) as unknown[]
  assert.equal(capped.length, 50)
})

test("buildOutputPreview：string 原样、对象 pretty JSON、2KB 截断、敏感键脱敏", () => {
  // string 原样（不包引号）
  assert.equal(buildOutputPreview("纯文本"), "纯文本")
  // 对象 pretty-print 且脱敏
  const preview = buildOutputPreview({ api_key: "sk-x", ok: true })
  assert.ok(preview.includes("[REDACTED]"))
  assert.ok(preview.includes("\"ok\": true"))
  // 超 2KB 截断
  const big = buildOutputPreview({ filler: "x".repeat(5000) })
  assert.ok(Buffer.byteLength(big, "utf8") <= OUTPUT_PREVIEW_LIMIT_BYTES)
  // 循环引用退化为 String() 不抛错
  const cyc: Record<string, unknown> = {}
  cyc.self = cyc
  const fallback = buildOutputPreview(cyc)
  assert.ok(typeof fallback === "string" && fallback.length > 0)
})

test("truncatePromptForJournal：超 4KB 截断到码点边界", () => {
  const long = "提示".repeat(3000)
  const cut = truncatePromptForJournal(long)
  assert.ok(Buffer.byteLength(cut, "utf8") <= 4096)
  assert.ok(!cut.includes("�"))
})
