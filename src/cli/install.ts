/**
 * 交互式安装流程
 *
 * 流程（Docs/npx cli安装方式-交互式安装器实施方案.md 第 3 节）：
 * 检测 OpenCode 版本 → 第一步选安装方式 → 第二步问 skill → 展示变更清单
 * → 确认 → [锁定模式先 npm install] → 合并 opencode.json → 合并 tui.json → 拷贝 skill
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as p from "@clack/prompts"

import {
  PKG_NAME,
  PLUGIN_SPEC_LOCAL,
  cliPackageRoot,
  detectInstalled,
  globalOpenCodeJsonPath,
  globalTuiJsonPath,
  globalCachePackageDir,
  mergePluginEntry,
  projectOpenCodeJsonPath,
  projectTuiJsonPath,
  skillTargets,
  copySkill,
  unwrap,
} from "./config.js"

type Mode = "global" | "project" | "locked"

interface InstallPlan {
  mode: Mode
  openCodeJson: string
  tuiJson: string
  pluginEntry: string
  withSkill: boolean
}

/** 检测 OpenCode 版本；命令不可用返回 null（仅 WARN 不阻塞） */
function detectOpencodeVersion(): string | null {
  const res = spawnSync("opencode --version", { encoding: "utf8", shell: true, timeout: 15_000 })
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
  const match = out.match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

export async function runInstall(): Promise<void> {
  p.intro("OpenCode Dynamic Workflows 安装器")

  // 环境检测：版本拿不到只警告
  const version = detectOpencodeVersion()
  if (version === null) {
    p.log.warn("未检测到 opencode 命令（可能仅安装了桌面版），将继续安装，请自行确认环境")
  } else {
    const major = Number(version.split(".")[0])
    if (major !== 1) {
      const go = await p.confirm({
        message: `检测到 OpenCode ${version}（本插件针对 v1 制作），仍要继续吗`,
      })
      if (!go) {
        p.outro("已取消")
        return
      }
    } else {
      p.log.step(`检测到 OpenCode ${version}`)
    }
  }

  // 第一步：选择安装方式
  const mode = unwrap(
    await p.select<Mode>({
      message: "请选择安装方式",
      options: [
        { value: "global", label: "全局安装", hint: "所有 OpenCode 项目生效" },
        { value: "project", label: "当前项目", hint: "仅当前项目生效" },
        { value: "locked", label: "当前项目 + 锁定版本", hint: "安装到 node_modules，适合团队协作" },
      ],
    }),
  )

  // 第二步：是否安装 skill
  const withSkill = unwrap(
    await p.confirm({
      message: "是否安装 workflow-authoring / workflow-optimize skill（拷贝到 OpenCode 标准 skill 目录）",
      initialValue: true,
    }),
  )

  const cwd = process.cwd()
  const isGlobal = mode === "global"
  const plan: InstallPlan = {
    mode,
    openCodeJson: isGlobal ? globalOpenCodeJsonPath() : projectOpenCodeJsonPath(cwd),
    tuiJson: isGlobal ? globalTuiJsonPath() : projectTuiJsonPath(cwd),
    // 锁定模式引用项目 node_modules 内的包，其余写包名交给 OpenCode 自动安装
    pluginEntry: mode === "locked" ? PLUGIN_SPEC_LOCAL : PKG_NAME,
    withSkill,
  }

  // 已安装检测：同方式重复安装给出提示（配置幂等，继续无副作用）
  const existing = detectInstalled(cwd).find((item) => item.kind === mode)
  if (existing) {
    p.log.info(`该方式似乎已安装（命中 ${existing.evidence}），继续将做增量合并`)
  }

  // 展示变更清单
  const lines = [
    `修改  ${plan.openCodeJson}（plugin += ${plan.pluginEntry}）`,
    `修改  ${plan.tuiJson}（plugin += ${plan.pluginEntry}）`,
  ]
  if (mode === "locked") lines.unshift(`执行  npm install ${PKG_NAME}（在 ${cwd}）`)
  if (withSkill) {
    const base = skillTargets(cwd, mode)[0].destDir
    lines.push(`拷贝  ${join(cliPackageRoot(), "skills")}/ 下两个 skill 到 ${base}/`)
  }
  p.note(lines.join("\n"), "将修改以下内容（原文件会留 .bak 备份）")

  if (!unwrap(await p.confirm({ message: "开始安装" }))) {
    p.outro("已取消")
    return
  }

  const s = p.spinner()
  try {
    // 锁定模式先装包
    if (mode === "locked") {
      s.start("安装 npm 包到当前项目")
      const res = spawnSync(`npm install ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
      if (res.status !== 0) throw new Error("npm install 失败，请检查网络后重试")
      s.stop(`npm 包已安装到 ${join(cwd, "node_modules")}`)
    }

    // 写两份配置（JSONC 增量合并，保留注释）
    s.start("合并 opencode.json")
    mergePluginEntry(plan.openCodeJson, plan.pluginEntry)
    s.stop(`已更新 ${plan.openCodeJson}`)

    s.start("合并 tui.json")
    mergePluginEntry(plan.tuiJson, plan.pluginEntry)
    s.stop(`已更新 ${plan.tuiJson}`)

    // 拷贝 skill（源为 CLI 自身包内的 skills/，不依赖 OpenCode 缓存是否已装）
    if (withSkill) {
      const targets = skillTargets(cwd, mode)
      for (const target of targets) {
        if (existsSync(target.destDir)) {
          const overwrite = unwrap(
            await p.confirm({
              message: `skill 目录已存在，覆盖吗：${target.destDir}`,
            }),
          )
          if (!overwrite) {
            p.log.info(`跳过 ${target.name}`)
            continue
          }
        }
        s.start(`拷贝 skill ${target.name}`)
        copySkill(join(cliPackageRoot(), "skills"), target)
        s.stop(`已拷贝 ${target.name} → ${target.destDir}`)
      }
    }
  } catch (error) {
    s.stop("安装失败")
    p.log.error(error instanceof Error ? error.message : String(error))
    p.outro("可运行 doctor 查看环境状态")
    return
  }

  p.outro(
    [
      "安装完成。请重启 OpenCode 使配置生效。",
      `全局缓存包位置（供参考）：${globalCachePackageDir()}`,
      "排查命令：npx @mickorz/opencode-dynamic-workflows doctor",
    ].join("\n"),
  )
}
