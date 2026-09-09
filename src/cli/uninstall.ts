/**
 * 交互式卸载流程
 *
 * 流程（方案第 4 节，用户核心需求）：
 * 检测三种安装方式与 skill 拷贝的存在性 → 零种提示退出 / 一种直接选中 /
 * 多种 multiselect 勾选（hint 展示命中证据）→ 确认 → 逐项移除配置条目
 * → 清理对应 skill 拷贝目录（逐个 confirm，防用户本地改动丢失）
 * → 清理遗留 skills.paths → locked 追加询问是否 npm uninstall
 */

import { spawnSync } from "node:child_process"
import * as p from "@clack/prompts"

import {
  PKG_NAME,
  detectInstalled,
  globalOpenCodeJsonPath,
  globalTuiJsonPath,
  globalSkillsTargetDir,
  projectOpenCodeJsonPath,
  projectTuiJsonPath,
  projectSkillsTargetDir,
  removePluginEntries,
  removeSkillTarget,
  skillTargets,
  skillTargetExists,
  unwrap,
  type InstallKind,
} from "./config.js"

interface UninstallOption {
  kind: InstallKind
  evidence: string
  /** 需要清理的 skill 目标目录 */
  skillBaseDir: string
}

const KIND_LABEL: Record<InstallKind, string> = {
  global: "全局安装",
  project: "当前项目（包名方式）",
  locked: "当前项目 + 锁定版本（node_modules）",
}

export async function runUninstall(): Promise<void> {
  p.intro("OpenCode Dynamic Workflows 卸载器")

  const cwd = process.cwd()
  const results = detectInstalled(cwd)

  // skill 拷贝存在性也纳入检测（拷贝了 skill 但配置已清的场景）
  const globalSkillInstalled = skillTargets(cwd, "global").some(skillTargetExists)
  const projectSkillInstalled = skillTargets(cwd, "project").some(skillTargetExists)

  const options: UninstallOption[] = []
  for (const item of results) {
    options.push({
      kind: item.kind,
      evidence: item.evidence,
      skillBaseDir: item.kind === "global" ? globalSkillsTargetDir() : projectSkillsTargetDir(cwd),
    })
  }
  if (globalSkillInstalled && !options.some((item) => item.kind === "global")) {
    options.push({ kind: "global", evidence: "仅存在已拷贝的 skill 目录（无插件配置）", skillBaseDir: globalSkillsTargetDir() })
  }
  if (projectSkillInstalled && !options.some((item) => item.kind === "project" || item.kind === "locked")) {
    options.push({ kind: "project", evidence: "仅存在已拷贝的 skill 目录（无插件配置）", skillBaseDir: projectSkillsTargetDir(cwd) })
  }

  if (options.length === 0) {
    p.log.warn("未检测到任何安装（配置与 skill 拷贝均不存在）")
    p.outro("已退出")
    return
  }

  // 列出存在项：一种直接选中展示，多种 multiselect 勾选
  let selected: UninstallOption[]
  if (options.length === 1) {
    selected = options
    p.log.info(`检测到 1 项：${KIND_LABEL[options[0].kind]}（命中 ${options[0].evidence}）`)
  } else {
    selected = unwrap(
      await p.multiselect<UninstallOption>({
        message: "检测到以下安装，选择要卸载的项",
        options: options.map((item) => ({
          value: item,
          label: KIND_LABEL[item.kind],
          hint: `命中 ${item.evidence}`,
        })),
        required: true,
      }),
    )
  }

  // 确认清单
  const planLines: string[] = []
  for (const item of selected) {
    if (item.kind === "global") {
      planLines.push(`移除配置  ${globalOpenCodeJsonPath()}`)
      planLines.push(`移除配置  ${globalTuiJsonPath()}`)
    } else {
      planLines.push(`移除配置  ${projectOpenCodeJsonPath(cwd)}`)
      planLines.push(`移除配置  ${projectTuiJsonPath(cwd)}`)
    }
    planLines.push(`清理 skill  ${item.skillBaseDir}/{workflow-authoring,workflow-optimize}`)
  }
  if (selected.some((item) => item.kind === "locked")) {
    planLines.push(`可选    npm uninstall ${PKG_NAME}（稍后询问）`)
  }
  p.note(planLines.join("\n"), "将执行以下卸载（配置文件会留 .bak 备份）")

  if (!unwrap(await p.confirm({ message: "开始卸载" }))) {
    p.outro("已取消")
    return
  }

  const s = p.spinner()
  try {
    // 1. 配置条目移除（global 与 project 各自的两个 json；函数内部只删匹配条目）
    const configFiles = new Set<string>()
    for (const item of selected) {
      if (item.kind === "global") {
        configFiles.add(globalOpenCodeJsonPath())
        configFiles.add(globalTuiJsonPath())
      } else {
        configFiles.add(projectOpenCodeJsonPath(cwd))
        configFiles.add(projectTuiJsonPath(cwd))
      }
    }
    s.start("移除配置条目")
    for (const file of configFiles) removePluginEntries(file)
    s.stop(`已处理 ${configFiles.size} 个配置文件（含遗留 skills.paths 清理）`)

    // 2. skill 目录清理（逐个 confirm，防用户本地改动丢失）
    for (const item of selected) {
      for (const target of skillTargets(cwd, item.kind)) {
        if (!skillTargetExists(target)) continue
        const remove = unwrap(
          await p.confirm({
            message: `删除 skill 目录（如有本地改动将丢失）：${target.destDir}`,
            initialValue: true,
          }),
        )
        if (!remove) {
          p.log.info(`保留 ${target.destDir}`)
          continue
        }
        s.start(`删除 skill ${target.name}`)
        removeSkillTarget(target)
        s.stop(`已删除 ${target.destDir}`)
      }
    }

    // 3. 锁定模式：询问是否顺带删除项目依赖
    if (selected.some((item) => item.kind === "locked")) {
      const alsoNpm = unwrap(
        await p.confirm({
          message: `顺带执行 npm uninstall ${PKG_NAME}（从项目 node_modules 删除）`,
          initialValue: false,
        }),
      )
      if (alsoNpm) {
        s.start("npm uninstall")
        const res = spawnSync(`npm uninstall ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
        if (res.status !== 0) throw new Error("npm uninstall 失败，可稍后手动执行")
        s.stop("项目依赖已移除")
      }
    }
  } catch (error) {
    s.stop("卸载失败")
    p.log.error(error instanceof Error ? error.message : String(error))
    p.outro("可运行 doctor 查看环境状态")
    return
  }

  p.outro("卸载完成。请重启 OpenCode 使配置生效（全局缓存未清理，如需彻底清除可手动删除 %USERPROFILE%\\.cache\\opencode\\packages\\@mickorz）。")
}
