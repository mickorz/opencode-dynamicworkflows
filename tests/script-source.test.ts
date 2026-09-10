/**
 * scriptPath 脚本来源解析测试（需求：工作流脚本陈旧缓存风险 方案 A）
 *
 * 覆盖：
 *  - 二选一校验：都缺报错、都传报错
 *  - scriptPath 服务端读盘：相对路径按 cwd 解析、绝对路径直读、原文原样返回
 *  - 文件不存在：报错带绝对路径（错误完整暴露）
 */

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveScriptText } from "../src/tools/script-source.js"

const META = `export const meta = { name: 't', description: 'd' }\nreturn 1\n`

test("都缺报错", () => {
  assert.throws(() => resolveScriptText({}, "/tmp"), /需要 script（脚本原文）或 scriptPath/)
  assert.throws(() => resolveScriptText({ script: "   " }, "/tmp"), /需要 script（脚本原文）或 scriptPath/)
})

test("都传报错", () => {
  assert.throws(
    () => resolveScriptText({ script: META, scriptPath: "a.js" }, "/tmp"),
    /二选一/,
  )})

test("script 原文原样返回", () => {
  assert.equal(resolveScriptText({ script: META }, "/tmp"), META)
})

test("scriptPath 相对路径按 cwd 解析读盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-source-"))
  try {
    writeFileSync(join(dir, "probe.js"), META, "utf8")
    assert.equal(resolveScriptText({ scriptPath: "probe.js" }, dir), META)
    assert.equal(resolveScriptText({ scriptPath: "./probe.js" }, dir), META)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scriptPath 绝对路径直读", () => {
  const dir = mkdtempSync(join(tmpdir(), "script-source-"))
  try {
    const abs = resolve(dir, "probe.js")
    writeFileSync(abs, META, "utf8")
    assert.equal(resolveScriptText({ scriptPath: abs }, "/somewhere/else"), META)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scriptPath 文件不存在报错带绝对路径", () => {
  const cwd = process.cwd()
  assert.throws(
    () => resolveScriptText({ scriptPath: "no-such-file.js" }, cwd),
    new RegExp(`scriptPath 读取失败.*${resolve(cwd, "no-such-file.js").replace(/[\\]/g, "\\\\")}`),
  )
})
