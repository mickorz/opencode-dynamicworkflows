/**
 * 环境排查（只读不写，任何一项失败不阻塞后续检查）
 *
 * 检查清单见方案第 5 节；来源为 Docs/npm插件分发TUI加载失败问题-注意事项.md 的排查路径。
 * 输出 [OK] / [WARN] / [FAIL] 纯文本前缀（项目规范禁止 emoji）。
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as p from "@clack/prompts"

import {
  PKG_NAME,
  cliPackageRoot,
  globalOpenCodeJsonPath,
  globalTuiJsonPath,
  globalCachePackageDir,
  projectOpenCodeJsonPath,
  projectTuiJsonPath,
  projectPackageDir,
  skillTargets,
  skillTargetExists,
  readJsonc,
} from "./config.js"

type Status = "OK" | "WARN" | "FAIL"

const results: { status: Status; label: string; detail: string }[] = []

function record(status: Status, label: string, detail = ""): void {
  results.push({ status, label, detail })
}

function runCapture(command: string, args: string[]): string | null {
  try {
    // Windows 下命令可能是 .cmd shim，需要 shell；命令拼为单串避免 args+shell 弃用警告
    const res = spawnSync([command, ...args].join(" "), { encoding: "utf8", shell: true, timeout: 30_000 })
    return `${res.stdout ?? ""}`.trim() || null
  } catch {
    return null
  }
}

function pluginConfigured(path: string): boolean {
  const loaded = readJsonc(path)
  const plugin = loaded?.data.plugin
  return Array.isArray(plugin) && plugin.some((item) => item === PKG_NAME || (typeof item === "string" && item.includes(PKG_NAME)))
}

function legacySkillPathsConfigured(path: string): boolean {
  const loaded = readJsonc(path)
  const paths = (loaded?.data.skills as Record<string, unknown> | undefined)?.paths
  return Array.isArray(paths) && paths.some((item) => typeof item === "string" && item.includes(PKG_NAME))
}

export async function runDoctor(): Promise<void> {
  p.intro("OpenCode Dynamic Workflows Doctor")

  const cwd = process.cwd()

  // 1. Node 与 npm 版本
  record("OK", `Node.js ${process.version}`)
  const npmVersion = runCapture("npm", ["--version"])
  if (npmVersion) record("OK", `npm ${npmVersion}`)
  else record("WARN", "npm 不可用", "spawn 失败")

  // 2. OpenCode 版本
  const ocVersion = runCapture("opencode", ["--version"])
  const versionMatch = ocVersion?.match(/(\d+\.\d+\.\d+)/)
  if (!versionMatch) record("WARN", "OpenCode 命令不可用", "未检测到 opencode（可能仅装桌面版）")
  else {
    const major = Number(versionMatch[1].split(".")[0])
    if (major === 1) record("OK", `OpenCode ${versionMatch[1]}`)
    else record("WARN", `OpenCode ${versionMatch[1]}`, "本插件针对 v1 制作，非 v1 环境未验证")
  }

  // 3. npm 上的最新版本 + CLI 自身版本比对（npx 缓存可能钉旧版）
  const ownVersion = readOwnVersion()
  const latestRaw = runCapture("npm", ["view", PKG_NAME, "version"])
  const latest = latestRaw?.match(/(\d+\.\d+\.\d+)/)?.[1]
  if (!latest) record("WARN", "npm 最新版本查询失败", "网络不可用或包未发布")
  else if (ownVersion && ownVersion !== latest)
    record("WARN", `CLI 版本 ${ownVersion} 落后于 npm 最新 ${latest}`, "建议 npx @mickorz/opencode-dynamic-workflows@latest 重跑")
  else record("OK", `npm 最新版本 ${latest}（CLI 自身 ${ownVersion ?? "未知"}）`)

  // 4/5. 全局配置
  record(pluginConfigured(globalOpenCodeJsonPath()) ? "OK" : "WARN", "全局 opencode.json 插件配置", globalOpenCodeJsonPath())
  record(pluginConfigured(globalTuiJsonPath()) ? "OK" : "WARN", "全局 tui.json 插件配置", globalTuiJsonPath())

  // 6. 当前项目配置（未配置为中性说明，不算失败）
  const projMain = pluginConfigured(projectOpenCodeJsonPath(cwd))
  const projTui = pluginConfigured(projectTuiJsonPath(cwd))
  if (projMain || projTui)
    record("OK", "当前项目插件配置", `${projectOpenCodeJsonPath(cwd)}${projTui ? ` + ${projectTuiJsonPath(cwd)}` : ""}`)
  else record("WARN", "当前项目未做项目级配置", "仅全局配置时此为正常状态")

  // 7. 全局缓存包安装与版本
  const cachePkgJson = join(globalCachePackageDir(), "package.json")
  if (existsSync(cachePkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(cachePkgJson, "utf8")) as { version?: string }
      record("OK", `全局缓存已安装 v${pkg.version ?? "?"}`, globalCachePackageDir())
    } catch {
      record("WARN", "全局缓存存在但 package.json 不可读", globalCachePackageDir())
    }
  } else record("WARN", "全局缓存未安装", globalCachePackageDir())
  if (existsSync(projectPackageDir(cwd)))
    record("OK", "项目 node_modules 已安装", projectPackageDir(cwd))

  // 8. Temp vendor 目录（TUI 加载链路，3 实现文件 + node_modules junction）
  const vendorRoot = process.env.TEMP
  const vendorDirs = vendorRoot && existsSync(vendorRoot)
    ? readdirSync(vendorRoot).filter((name) => name.startsWith("opencode-dynamic-workflows-vendor-"))
    : []
  if (vendorDirs.length === 0) {
    record("WARN", "未发现 TUI vendor 目录", "插件从未在 npm 安装方式下加载过 TUI，或尚未重启 OpenCode")
  } else {
    // 只看按版本排序的最新一个（vendorDirs 非空，at(-1) 必有值）
    const latestVendor = vendorDirs.sort().at(-1) as string
    const dir = join(vendorRoot as string, latestVendor)
    const srcOk = existsSync(join(dir, "src", "plugin.tsx")) && existsSync(join(dir, "src", "run-snapshot-reader.ts"))
    const nmOk = existsSync(join(dir, "node_modules"))
    if (srcOk && nmOk) record("OK", `TUI vendor 完整（${latestVendor}）`, dir)
    else
      record(
        "FAIL",
        `TUI vendor 不完整（${latestVendor}）`,
        `src 实现文件${srcOk ? "齐" : "缺"}，node_modules 链接${nmOk ? "在" : "缺"}；请升级到 0.1.2 以上并清缓存重启`,
      )
  }

  // 9. skill 拷贝目录
  for (const [scope, targets] of [
    ["全局", skillTargets(cwd, "global")],
    ["项目", skillTargets(cwd, "project")],
  ] as const) {
    const installed = targets.filter(skillTargetExists)
    if (installed.length > 0) record("OK", `${scope} skill 已拷贝（${installed.length}/${targets.length}）`, installed[0].destDir)
  }

  // 10. 遗留 skills.paths 配置（已废弃写法，提示清理）
  for (const [label, path] of [
    ["全局", globalOpenCodeJsonPath()],
    ["项目", projectOpenCodeJsonPath(cwd)],
  ] as const) {
    if (legacySkillPathsConfigured(path))
      record("WARN", `${label}配置存在废弃的 skills.paths 写法`, `${path}，建议 uninstall 重新 install 清理`)
  }

  // 汇总输出
  for (const item of results) {
    const detail = item.detail ? ` —— ${item.detail}` : ""
    p.log.message(`[${item.status}] ${item.label}${detail}`)
  }

  const fail = results.filter((item) => item.status === "FAIL").length
  const warn = results.filter((item) => item.status === "WARN").length
  p.outro(`检查完成：${results.length - fail - warn} 项 OK，${warn} 项 WARN，${fail} 项 FAIL`)
}

/** 读取 CLI 自身包版本（npx 缓存中运行的版本） */
function readOwnVersion(): string | null {
  try {
    const pkgPath = join(cliPackageRoot(), "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
