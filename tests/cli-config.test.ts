/**
 * CLI 配置工具测试（config.ts 纯逻辑，临时目录注入，不碰真实配置）
 *
 * 对应方案第 9 节用例 1-9。
 */

import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import {
  PKG_NAME,
  PKG_IN_NODE_MODULES,
  PLUGIN_SPEC_LOCAL,
  isPluginEntry,
  isSkillPathEntry,
  mergePluginEntry,
  removePluginEntries,
  detectInstalled,
  copySkill,
  skillTargets,
  skillTargetExists,
} from "../src/cli/config.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "odw-cli-test-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function openCodeJson(): string {
  return join(dir, "opencode.json")
}

function tuiJson(): string {
  return join(dir, "tui.json")
}

test("用例1 空 JSONC 创建 plugin 数组并写入包名", () => {
  mergePluginEntry(openCodeJson(), PKG_NAME)
  const data = JSON.parse(readFileSync(openCodeJson(), "utf8"))
  assert.deepEqual(data.plugin, [PKG_NAME])
  assert.equal(data.$schema, "https://opencode.ai/config.json")
})

test("用例2 已有其他插件条目时增量追加不覆盖", () => {
  writeFileSync(
    openCodeJson(),
    JSON.stringify({ plugin: ["@langfuse/opencode-observability-plugin"] }),
    "utf8",
  )
  mergePluginEntry(openCodeJson(), PKG_NAME)
  const data = JSON.parse(readFileSync(openCodeJson(), "utf8"))
  assert.deepEqual(data.plugin, ["@langfuse/opencode-observability-plugin", PKG_NAME])
})

test("用例3 重复安装幂等 不产生重复条目", () => {
  mergePluginEntry(openCodeJson(), PKG_NAME)
  assert.equal(mergePluginEntry(openCodeJson(), PKG_NAME), false)
  const data = JSON.parse(readFileSync(openCodeJson(), "utf8"))
  assert.equal(data.plugin.filter((item: string) => item === PKG_NAME).length, 1)
})

test("用例4 JSONC 注释在 merge 后保留", () => {
  writeFileSync(
    openCodeJson(),
    `{\n  // 测试工程配置注释\n  "plugin": ["@langfuse/opencode-observability-plugin"]\n}`,
    "utf8",
  )
  mergePluginEntry(openCodeJson(), PKG_NAME)
  const text = readFileSync(openCodeJson(), "utf8")
  assert.ok(text.includes("// 测试工程配置注释"), "注释应保留")
  const data = JSON.parse(text.replace(/\/\/.*/g, ""))
  assert.ok(data.plugin.includes(PKG_NAME))
})

test("用例5 uninstall 移除仅删匹配条目 其他条目与 skills 结构保留", () => {
  writeFileSync(
    openCodeJson(),
    JSON.stringify({
      plugin: ["@langfuse/opencode-observability-plugin", PKG_NAME],
      skills: { paths: ["./my-skills", `node_modules/${PKG_NAME}/skills`] },
    }),
    "utf8",
  )
  assert.equal(removePluginEntries(openCodeJson()), true)
  const data = JSON.parse(readFileSync(openCodeJson(), "utf8"))
  assert.deepEqual(data.plugin, ["@langfuse/opencode-observability-plugin"])
  // 非本插件的 skill 路径保留；本插件的清掉；skills 对象保留空数组
  assert.deepEqual(data.skills.paths, ["./my-skills"])
})

test("用例6 tui.json 不存在时创建 存在时合并", () => {
  mergePluginEntry(tuiJson(), PKG_NAME)
  assert.deepEqual(JSON.parse(readFileSync(tuiJson(), "utf8")).plugin, [PKG_NAME])
  // 已有其他条目时再合并
  rmSync(tuiJson(), { force: true })
  writeFileSync(tuiJson(), JSON.stringify({ plugin: ["other-plugin"] }), "utf8")
  mergePluginEntry(tuiJson(), PKG_NAME)
  assert.deepEqual(JSON.parse(readFileSync(tuiJson(), "utf8")).plugin, ["other-plugin", PKG_NAME])
})

test("用例7 三种条目匹配规则（包名 / 相对路径 / 结尾容错）", () => {
  assert.equal(isPluginEntry(PKG_NAME), true)
  assert.equal(isPluginEntry(PLUGIN_SPEC_LOCAL), true)
  assert.equal(isPluginEntry(`E:/proj/${PKG_IN_NODE_MODULES}`), true)
  assert.equal(isPluginEntry("opencode-wakatime"), false)
  assert.equal(isPluginEntry("@langfuse/opencode-observability-plugin"), false)
  assert.equal(isPluginEntry(42), false)
})

test("用例8 skills.paths 遗留条目清理判定", () => {
  assert.equal(isSkillPathEntry(`node_modules/${PKG_NAME}/skills`), true)
  // 全局缓存路径形态（历史遗留写法，结尾正好是 PKG_NAME/skills，应清理）
  assert.equal(isSkillPathEntry(`~/.cache/opencode/packages/@mickorz/opencode-dynamic-workflows/skills`), true)
  assert.equal(isSkillPathEntry("./my-skills"), false)
})

test("用例9 skill 拷贝到临时目录验证目录树完整", () => {
  // 用临时源模拟包内 skills 结构
  const sourceBase = join(dir, "fake-pkg", "skills")
  mkdirSync(join(sourceBase, "workflow-authoring"), { recursive: true })
  writeFileSync(join(sourceBase, "workflow-authoring", "SKILL.md"), "# skill", "utf8")
  mkdirSync(join(sourceBase, "workflow-authoring", "examples"), { recursive: true })
  writeFileSync(join(sourceBase, "workflow-authoring", "examples", "a.js"), "//", "utf8")

  const targets = skillTargets(dir, "project")
  const authoring = targets.find((item) => item.name === "workflow-authoring")
  assert.ok(authoring)
  copySkill(sourceBase, authoring)

  assert.equal(skillTargetExists(authoring), true)
  assert.ok(existsSync(join(authoring.destDir, "examples", "a.js")))
})

test("补充 detectInstalled 识别包名 锁定 全局三种方式", () => {
  // 项目级包名方式（globalDir 注入隔离的临时目录，避免扫到真实全局配置）
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: [PKG_NAME] }), "utf8")
  writeFileSync(join(dir, "tui.json"), JSON.stringify({ plugin: [PKG_NAME] }), "utf8")
  const asProject = detectInstalled(dir, dir)
  assert.ok(asProject.some((item) => item.kind === "project"))

  // 锁定方式（plugin 为 node_modules 路径）
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: [PLUGIN_SPEC_LOCAL] }), "utf8")
  const asLocked = detectInstalled(dir, dir)
  assert.ok(asLocked.some((item) => item.kind === "locked"))

  // 全局方式：globalDir 指向含配置的临时目录
  const globalDir = mkdirSync(join(dir, "fake-global"), { recursive: true }) as string
  writeFileSync(join(globalDir, "opencode.json"), JSON.stringify({ plugin: [PKG_NAME] }), "utf8")
  const asGlobal = detectInstalled(join(dir, "empty-cwd"), globalDir)
  assert.ok(asGlobal.some((item) => item.kind === "global"))

  // 空场景不误报
  const emptyDir = mkdirSync(join(dir, "empty"), { recursive: true }) as string
  assert.deepEqual(detectInstalled(emptyDir, emptyDir), [])
})
