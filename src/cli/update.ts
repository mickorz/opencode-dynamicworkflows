/**
 * 插件本体与 skill 升级流程
 *
 * 流程（方案 3.1 节）：检测安装方式 → 当前版本对比 npm 最新 → 确认
 * → 包名方式删全局缓存（OpenCode 下次启动重装最新）→ 锁定方式 npm update
 * → skill 从最新包源重新拷贝覆盖（update 语义，不逐个询问）
 *
 * 边界：update 自身可能跑在 npx 旧缓存上，但删缓存 / npm update / 拷 skill
 * 不依赖新逻辑，效果等价；CLI 自身升级仍靠 @latest 强刷（版本自检在 doctor）。
 */

import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as p from "@clack/prompts"

import {
  PKG_NAME,
  SKILL_NAMES,
  cliPackageRoot,
  detectInstalled,
  globalCacheScopeDir,
  readInstalledVersion,
  skillTargets,
  copySkill,
  unwrap,
} from "./config.js"

/** 查询 npm 上的最新版本；网络失败返回 null */
function fetchLatestVersion(): string | null {
  const res = spawnSync(`npm view ${PKG_NAME} version`, { encoding: "utf8", shell: true, timeout: 30_000 })
  const out = (res.stdout ?? "").trim()
  return /^\d+\.\d+\.\d+/.test(out) ? out : null
}

export async function runUpdate(): Promise<void> {
  p.intro("OpenCode Dynamic Workflows 更新器")

  const cwd = process.cwd()
  const results = detectInstalled(cwd)
  if (results.length === 0) {
    p.log.warn("未检测到任何安装，请先执行 install")
    p.outro("已退出")
    return
  }

  const current = readInstalledVersion(cwd)
  const latest = fetchLatestVersion()
  const lines = [
    ...results.map((item) => `${item.kind}：命中 ${item.evidence}`),
    `当前插件版本：${current ?? "未知"}　npm 最新版本：${latest ?? "查询失败"}`,
  ]
  p.note(lines.join("\n"), "安装状态")

  if (current !== null && latest !== null && current === latest) {
    p.outro("已是最新版本，无需更新")
    return
  }

  const go = unwrap(
    await p.confirm({
      message: latest === null ? "无法查询最新版本（离线？），仍要按最新可用包刷新吗" : `更新到 ${latest}`,
    }),
  )
  if (!go) {
    p.outro("已取消")
    return
  }

  const s = p.spinner()
  try {
    for (const item of results) {
      if (item.kind === "global" || item.kind === "project") {
        // 包名方式：插件本体在 OpenCode 全局缓存，删缓存后下次启动自动重装最新
        s.start(`清理全局缓存（${item.kind}）`)
        rmSync(globalCacheScopeDir(), { recursive: true, force: true })
        s.stop("全局缓存已清理，OpenCode 下次启动将重装最新版")
      }
      if (item.kind === "locked") {
        s.start("项目内 npm update 至最新")
        const res = spawnSync(`npm update ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
        if (res.status !== 0) throw new Error("npm update 失败，请检查网络后重试")
        s.stop("项目依赖已更新")
      }
    }

    // skill 刷新：从 CLI 自身包源重新拷贝覆盖（update 语义不逐个询问）
    const sourceBase = join(cliPackageRoot(), "skills")
    for (const item of results) {
      const targets = skillTargets(cwd, item.kind)
      const overwritten: string[] = []
      for (const target of targets) {
        const existed = existsSync(target.destDir)
        s.start(`刷新 skill ${target.name}（${item.kind}）`)
        copySkill(sourceBase, target)
        overwritten.push(existed ? `${target.name}（覆盖）` : `${target.name}（新增）`)
        s.stop(`skill ${target.name} → ${target.destDir}`)
      }
      if (overwritten.length > 0) {
        p.log.info(`${item.kind} skill：${overwritten.join("、")}`)
      }
    }

    // 提醒 SKILL_NAMES 之外可能有旧拷贝残留（当前仅两个内置 skill，防未来改名遗留）
    p.log.info(`内置 skill 清单：${SKILL_NAMES.join("、")}`)
  } catch (error) {
    s.stop("更新失败")
    p.log.error(error instanceof Error ? error.message : String(error))
    p.outro("可运行 doctor 查看环境状态")
    return
  }

  p.outro("更新完成。请重启 OpenCode 使新版本生效。")
}
