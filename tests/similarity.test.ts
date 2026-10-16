/**
 * P4.1-A Similarity 指纹单元测试
 *
 * 覆盖需求 V41-1/2/3：
 *  - L1：仅注释/空白/引号差异同指纹
 *  - L2：变量重命名/参数化变体同结构指纹
 *  - L2：阈值/字段名/配置键不同 -> 不同指纹（常量不折叠）
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeScript,
  normalizedFingerprint,
  structuralFingerprint,
  tokenize,
  similarityGroupId,
} from "../src/development/similarity.js"

const BASE = `import json
def validate(config):
    # 检查年龄下限
    if not isinstance(config, dict):
        return False
    return config['age'] >= 18
`

// ============================================================
// L1 规范化
// ============================================================

test("L1：注释差异归一（行注释与块注释）", () => {
  const withComments = `import json  // 导入
def validate(config):
    /* 块注释 */
    # 另一行注释
    if not isinstance(config, dict):
        return False
    return config['age'] >= 18
`
  assert.equal(normalizedFingerprint(BASE), normalizedFingerprint(withComments))
})

test("L1：空白差异归一（空行/缩进/行尾）", () => {
  const spaced = `import json


def validate(config):
        if not isinstance(config, dict):

            return False
        return config['age'] >= 18
`
  assert.equal(normalizedFingerprint(BASE), normalizedFingerprint(spaced))
})

test("L1：引号风格归一（单双引号）", () => {
  const double = BASE.replace("config['age']", 'config["age"]')
  assert.equal(normalizedFingerprint(BASE), normalizedFingerprint(double))
})

test("L1：内容不同不归一", () => {
  const changed = BASE.replace(">= 18", ">= 65")
  assert.notEqual(normalizedFingerprint(BASE), normalizedFingerprint(changed))
})

// ============================================================
// L2 结构指纹
// ============================================================

test("L2：变量重命名同结构指纹", () => {
  const renamed = `import json
def check(data):
    if not isinstance(data, dict):
        return False
    return data['age'] >= 18
`
  assert.equal(structuralFingerprint(BASE), structuralFingerprint(renamed))
})

test("L2：函数名与参数名重命名（JS 侧）同结构指纹", () => {
  const a = `function validateConfig(cfg) {
  if (typeof cfg !== 'object') return false
  return cfg['age'] >= 18
}
`
  const b = `function checkAge(item) {
  if (typeof item !== "object") return false
  return item["age"] >= 18
}
`
  assert.equal(structuralFingerprint(a), structuralFingerprint(b))
})

test("L2：阈值不同（18 vs 65）不同结构指纹（常量不折叠）", () => {
  const older = BASE.replace(">= 18", ">= 65")
  assert.notEqual(structuralFingerprint(BASE), structuralFingerprint(older))
})

test("L2：字段名不同（age vs salary）不同结构指纹", () => {
  const otherField = BASE.replace("'age'", "'salary'")
  assert.notEqual(structuralFingerprint(BASE), structuralFingerprint(otherField))
})

test("L2：配置键不同不同结构指纹", () => {
  const a = `cfg = load('config.json')
`
  const b = `cfg = load('settings.json')
`
  assert.notEqual(structuralFingerprint(a), structuralFingerprint(b))
})

test("L2：控制流形状不同不同结构指纹", () => {
  const flat = `import json
def validate(config):
    return isinstance(config, dict) and config['age'] >= 18
`
  // BASE 有 if 分支形状，flat 是单表达式：结构不同
  assert.notEqual(structuralFingerprint(BASE), structuralFingerprint(flat))
})

test("tokenize：标识符占位、字符串与数字保留、关键字保留", () => {
  const tokens = tokenize(`if count >= 3: print("age", 'ok')`)
  assert.ok(tokens.includes("if"), "关键字保留")
  assert.ok(tokens.includes("ID"), "标识符占位（count/print）")
  assert.ok(tokens.includes("3"), "数字保留")
  assert.ok(tokens.includes('"age"') && tokens.includes('"ok"'), "字符串内容保留（引号统一后）")
})

test("similarityGroupId：锚点指纹派生，稳定，不含级别前缀", () => {
  const id1 = similarityGroupId("a".repeat(64))
  const id2 = similarityGroupId("a".repeat(64))
  assert.equal(id1, id2)
  assert.equal(id1, "sim-" + "a".repeat(16))
  assert.notEqual(id1, similarityGroupId("b".repeat(64)))
})

test("L1 严格于 L2：结构相同但常量不同时 L1 指纹不同、可在 L2 层互异", () => {
  const a = BASE
  const b = BASE.replace(">= 18", ">= 65")
  // 两者在 L2 也应不同（常量保留）——这正是常量不折叠的防线
  assert.notEqual(structuralFingerprint(a), structuralFingerprint(b))
  assert.notEqual(normalizedFingerprint(a), normalizedFingerprint(b))
})
