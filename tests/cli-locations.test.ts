/**
 * CLI 分发目标解析测试：skill/command 旧位置探测（.opencode 下任意深度，防双份冲突）
 * 覆盖：无旧位置走默认 / 顶层命中 / 嵌套子目录命中 / copyCommands 覆盖旧位置且不产默认副本 /
 *       removeCommands 清理旧位置 / uninstall 场景 skillTargets 命中
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { skillTargets, copyCommands, removeCommands, commandTargetDir } from "../src/cli/config.js"

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wf-cli-loc-"))
}

test("skill 目标：无旧位置时走默认 .agents/skills", () => {
  const dir = tmpProject()
  const targets = skillTargets(dir, "project")
  assert.equal(targets[0].destDir, path.join(dir, ".agents", "skills", "workflow-authoring"))
})

test("skill 目标：.opencode/skills 顶层同名已存在时命中旧位置", () => {
  const dir = tmpProject()
  const old = path.join(dir, ".opencode", "skills", "workflow-authoring")
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, "SKILL.md"), "旧版", "utf-8")
  const targets = skillTargets(dir, "project")
  assert.equal(targets[0].destDir, old, "目标改为旧位置（覆盖，不再装 .agents 防双份）")
  // 未命中的另一个 skill 仍走默认
  assert.equal(targets[1].destDir, path.join(dir, ".agents", "skills", "workflow-optimize"))
})

test("skill 目标：嵌套子文件夹（.opencode/skills/sub/deep/<name>）同样命中", () => {
  const dir = tmpProject()
  const old = path.join(dir, ".opencode", "skills", "legacy", "deep", "workflow-authoring")
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, "SKILL.md"), "深层旧版", "utf-8")
  const targets = skillTargets(dir, "project")
  assert.equal(targets[0].destDir, old)
})

test("skill 目标：同名目录但无 SKILL.md 不算已安装（继续下探）", () => {
  const dir = tmpProject()
  const emptyDir = path.join(dir, ".opencode", "skills", "workflow-authoring")
  fs.mkdirSync(emptyDir, { recursive: true }) // 无 SKILL.md
  const targets = skillTargets(dir, "project")
  assert.equal(targets[0].destDir, path.join(dir, ".agents", "skills", "workflow-authoring"), "空同名目录不算，走默认")
})

test("copyCommands：默认位置（无旧位置）", () => {
  const dir = tmpProject()
  const written = copyCommands(dir, "project")
  assert.equal(written, path.join(dir, ".opencode", "commands", "schedule.md"))
  assert.ok(fs.existsSync(written))
})

test("copyCommands：嵌套旧位置命中时覆盖该处，不产默认位置副本", () => {
  const dir = tmpProject()
  const old = path.join(dir, ".opencode", "commands", "sub", "schedule.md")
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.writeFileSync(old, "旧版命令", "utf-8")
  const written = copyCommands(dir, "project")
  assert.equal(written, old, "覆盖旧位置")
  assert.ok(!fs.existsSync(path.join(commandTargetDir(dir, "project"), "schedule.md")), "不产默认位置副本（防双份）")
  assert.notEqual(fs.readFileSync(old, "utf-8"), "旧版命令", "内容已更新")
})

test("removeCommands：清理嵌套旧位置", () => {
  const dir = tmpProject()
  const old = path.join(dir, ".opencode", "commands", "sub", "schedule.md")
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.writeFileSync(old, "x", "utf-8")
  removeCommands(dir, "project")
  assert.ok(!fs.existsSync(old))
})
