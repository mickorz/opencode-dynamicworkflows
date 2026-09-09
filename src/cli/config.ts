/**
 * CLI 配置与检测工具（install / update / uninstall / doctor 共用）
 *
 * 职责：
 * 1. 路径解析（全局配置目录、全局缓存、项目路径、skill 目标目录）
 * 2. JSONC 配置的增量读写（保留注释与格式，最小修订）
 * 3. 插件条目匹配与三种安装方式的存在性检测
 * 4. skill 目录拷贝（copy 语义，Windows 免特权）
 *
 * 安装方式与条目匹配规则见 Docs/npx cli安装方式-交互式安装器实施方案.md 第 2 节。
 */

import { existsSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type FormattingOptions } from "jsonc-parser"

/** npm 包名（plugin 配置的包名形式条目） */
export const PKG_NAME = "@mickorz/opencode-dynamic-workflows"
/** 包在 node_modules 下的相对路径 */
export const PKG_IN_NODE_MODULES = "node_modules/@mickorz/opencode-dynamic-workflows"
/** 锁定模式的 plugin 条目（相对项目根） */
export const PLUGIN_SPEC_LOCAL = "./node_modules/@mickorz/opencode-dynamic-workflows"
/** 包内 skills 目录（skill 拷贝源，位于 CLI 自身包根） */
export const SKILL_NAMES = ["workflow-authoring", "workflow-optimize"] as const

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 全局配置目录：优先 ~/.config/opencode（本机实测生效），不存在时回退 %APPDATA%/opencode */
export function globalConfigDir(): string {
  const home = homedir()
  const preferred = join(home, ".config", "opencode")
  if (existsSync(preferred)) return preferred
  const appData = process.env.APPDATA
  if (appData) return join(appData, "opencode")
  return preferred
}

export function globalOpenCodeJsonPath(): string {
  return join(globalConfigDir(), "opencode.json")
}

export function globalTuiJsonPath(): string {
  return join(globalConfigDir(), "tui.json")
}

export function projectOpenCodeJsonPath(cwd: string): string {
  return join(cwd, "opencode.json")
}

export function projectTuiJsonPath(cwd: string): string {
  return join(cwd, "tui.json")
}

/** OpenCode 1.18.29 的 npm 插件缓存包装目录（非官方文档写的 node_modules/） */
export function globalCacheScopeDir(): string {
  return join(homedir(), ".cache", "opencode", "packages", "@mickorz")
}

/** 全局缓存中包本体的候选位置（bun 安装结构：wrapper/node_modules/@scope/name） */
export function globalCachePackageDir(): string {
  return join(globalCacheScopeDir(), "opencode-dynamic-workflows", "node_modules", "@mickorz", "opencode-dynamic-workflows")
}

/** 项目 node_modules 中包本体的位置 */
export function projectPackageDir(cwd: string): string {
  return join(cwd, PKG_IN_NODE_MODULES)
}

/** skill 全局目标目录（~/.config/opencode/skills，OpenCode 原生扫描） */
export function globalSkillsTargetDir(): string {
  return join(globalConfigDir(), "skills")
}

/** skill 项目目标目录（.agents/skills，OpenCode 原生扫描且向上遍历） */
export function projectSkillsTargetDir(cwd: string): string {
  return join(cwd, ".agents", "skills")
}

/** CLI 自身包根（npx 运行时位于 npx 缓存；skill 拷贝源取此处，不依赖 OpenCode 缓存是否已装） */
export function cliPackageRoot(): string {
  // 编译后位于 dist/cli/config.js，包根为其上两级；源码运行（tsx）时为仓库根，同样成立
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..")
}

// ---------------------------------------------------------------------------
// 条目匹配
// ---------------------------------------------------------------------------

/** plugin 数组条目是否为本插件的（包名 / 相对路径 / 结尾容错，见方案第 2 节） */
export function isPluginEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false
  return (
    entry === PKG_NAME ||
    entry === PLUGIN_SPEC_LOCAL ||
    entry.replaceAll("\\", "/").endsWith(PKG_IN_NODE_MODULES)
  )
}

/** skills.paths 条目是否为本插件 skill 的（含历史遗留的两种写法） */
export function isSkillPathEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false
  return entry.replaceAll("\\", "/").endsWith(`${PKG_NAME}/skills`)
}

// ---------------------------------------------------------------------------
// JSONC 增量读写
// ---------------------------------------------------------------------------

interface LoadedConfig {
  path: string
  text: string
  data: Record<string, unknown>
}

/** 读 JSONC 文件；不存在返回 null。data 为解析后的对象（含注释容忍） */
export function readJsonc(path: string): LoadedConfig | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8")
  const data = parse(text) as Record<string, unknown>
  if (data === undefined || data === null || typeof data !== "object") return null
  return { path, text, data }
}

const FORMAT: FormattingOptions = { tabSize: 2, insertSpaces: true }

/**
 * 向配置的 plugin 数组增量写入条目（已存在同值条目则跳过，幂等）。
 * 数组不存在时创建；写回前备份 .bak；返回是否发生了修改。
 */
export function mergePluginEntry(path: string, entry: string): boolean {
  const loaded = ensureLoaded(path)
  const original = loaded.text
  let text = loaded.text
  const plugin = (loaded.data.plugin as unknown[] | undefined) ?? []
  if (plugin.some((item) => item === entry)) return false

  const next = [...plugin, entry]
  // 数组整体替换而非逐元素插入：jsonc-parser 的 modify 对数组下标插入需要 isArrayInsertion，
  // 整体替换语义更直白且对已有元素零影响
  text = applyEdits(text, modify(text, ["plugin"], next, { formattingOptions: FORMAT }))
  return writeWithBackup(path, original, text)
}

/**
 * 从配置中移除本插件相关条目：
 * plugin 数组中匹配 isPluginEntry 的元素；skills.paths 中匹配 isSkillPathEntry 的元素。
 * 数组清空后连键一起移除（避免留下 plugin: [] 空壳，配合 isShellConfig 整文件删除）。返回是否发生了修改。
 */
export function removePluginEntries(path: string): boolean {
  const loaded = readJsonc(path)
  if (!loaded) return false
  const original = loaded.text
  let text = original
  let changed = false

  const plugin = loaded.data.plugin
  if (Array.isArray(plugin)) {
    const next = plugin.filter((item) => !isPluginEntry(item))
    if (next.length !== plugin.length) {
      // modify 传 undefined 即删除该属性
      text = applyEdits(text, modify(text, ["plugin"], next.length > 0 ? next : undefined, { formattingOptions: FORMAT }))
      changed = true
    }
  }

  const skills = loaded.data.skills as Record<string, unknown> | undefined
  const paths = skills?.paths
  if (Array.isArray(paths)) {
    const next = paths.filter((item) => !isSkillPathEntry(item))
    if (next.length !== paths.length) {
      text = applyEdits(text, modify(text, ["skills", "paths"], next.length > 0 ? next : undefined, { formattingOptions: FORMAT }))
      changed = true
    }
  }

  if (!changed) return false
  return writeWithBackup(path, original, text)
}

/**
 * 配置移除条目后是否只剩空壳（$schema 与空数组/空对象）。
 * 安装器从零创建的配置（如 tui.json）卸载后会退化成这种骨架，留着只会困惑，卸载流程据此整文件删除。
 */
export function isShellConfig(path: string): boolean {
  const loaded = readJsonc(path)
  if (!loaded) return false
  return Object.keys(loaded.data).every((key) => {
    if (key === "$schema") return true
    const value = loaded.data[key]
    if (Array.isArray(value)) return value.length === 0
    if (value !== null && typeof value === "object") return Object.keys(value).length === 0
    return false
  })
}

/** 整体删除配置文件与其 .bak 备份（不存在则静默跳过） */
export function removeConfigWithBackup(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}.bak`, { force: true })
}

function ensureLoaded(path: string): LoadedConfig {
  const loaded = readJsonc(path)
  if (loaded) return loaded
  // 不存在则准备一个带 $schema 的最小骨架文本（创建场景）
  const text = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`
  writeFileSync(path, text, "utf8")
  return { path, text, data: parse(text) as Record<string, unknown> }
}

function writeWithBackup(path: string, originalText: string, nextText: string): boolean {
  if (originalText.trim() === nextText.trim()) return false
  try {
    writeFileSync(`${path}.bak`, originalText, "utf8")
  } catch {
    // 备份失败不阻塞写入（例如只读目录），主流程继续
  }
  writeFileSync(path, nextText, "utf8")
  return true
}

/**
 * 收窄 @clack 交互返回值：用户取消（ctrl+c）直接退出进程，否则返回值本体。
 * 不用 isCancel 做负向收窄：其 type guard 指向 unique symbol，无法从宽泛 symbol 联合中排除。
 */
export function unwrap<T>(value: T | symbol): T {
  if (typeof value === "symbol") process.exit(0)
  return value
}

// ---------------------------------------------------------------------------
// 存在性检测（install / update / uninstall / doctor 共用）
// ---------------------------------------------------------------------------

export type InstallKind = "global" | "project" | "locked"

export interface DetectResult {
  kind: InstallKind
  /** 命中证据描述（哪个文件 / 哪个目录） */
  evidence: string
}

function fileHitsPlugin(path: string): boolean {
  const loaded = readJsonc(path)
  if (!loaded) return false
  const plugin = loaded.data.plugin
  return Array.isArray(plugin) && plugin.some((item) => isPluginEntry(item))
}

/** 检测三种安装方式的存在性与命中证据（cwd 为用户项目根，即 process.cwd()；globalDir 供测试注入） */
export function detectInstalled(cwd: string, globalDir = globalConfigDir()): DetectResult[] {
  const results: DetectResult[] = []

  const globalHits = [join(globalDir, "opencode.json"), join(globalDir, "tui.json")].filter(fileHitsPlugin)
  if (globalHits.length > 0) {
    results.push({ kind: "global", evidence: globalHits.join(" + ") })
  }

  const projectJsonHits = [projectOpenCodeJsonPath(cwd), projectTuiJsonPath(cwd)].filter(fileHitsPlugin)
  const lockedByPath = projectJsonHits.some((path) => {
    const loaded = readJsonc(path)
    const plugin = loaded?.data.plugin
    return Array.isArray(plugin) && plugin.some((item) => typeof item === "string" && item !== PKG_NAME && isPluginEntry(item))
  })
  const lockedByModules = existsSync(projectPackageDir(cwd))
  if (projectJsonHits.length > 0) {
    results.push({
      kind: lockedByPath || lockedByModules ? "locked" : "project",
      evidence: projectJsonHits.join(" + "),
    })
  } else if (lockedByModules) {
    results.push({ kind: "locked", evidence: projectPackageDir(cwd) })
  }

  return results
}

/** 读取已安装包的版本号：优先全局缓存，其次项目 node_modules；都没有返回 null */
export function readInstalledVersion(cwd: string): string | null {
  for (const dir of [globalCachePackageDir(), projectPackageDir(cwd)]) {
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
        return pkg.version ?? null
      } catch {
        return null
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// skill 拷贝
// ---------------------------------------------------------------------------

export interface SkillCopyTarget {
  /** skill 名（包内 skills/ 下的目录名） */
  name: string
  /** 目标目录绝对路径 */
  destDir: string
}

/** 计算 skill 拷贝目标列表：global 模式到 ~/.config/opencode/skills，其余到 .agents/skills */
export function skillTargets(cwd: string, mode: "global" | "project" | "locked"): SkillCopyTarget[] {
  const base = mode === "global" ? globalSkillsTargetDir() : projectSkillsTargetDir(cwd)
  return SKILL_NAMES.map((name) => ({ name, destDir: join(base, name) }))
}

/** 递归拷贝单个 skill 目录到目标（目标父目录自动创建；已存在时整体替换） */
export function copySkill(sourceBaseDir: string, target: SkillCopyTarget): void {
  const src = join(sourceBaseDir, target.name)
  if (!existsSync(src)) {
    throw new Error(`skill 源目录不存在：${src}`)
  }
  mkdirSync(target.destDir, { recursive: true })
  rmSync(target.destDir, { recursive: true, force: true })
  cpSync(src, target.destDir, { recursive: true })
}

/** 删除已拷贝的 skill 目录（不存在则静默跳过） */
export function removeSkillTarget(target: SkillCopyTarget): void {
  rmSync(target.destDir, { recursive: true, force: true })
}

/** 供 doctor 判断 skill 目录是否已拷贝 */
export function skillTargetExists(target: SkillCopyTarget): boolean {
  return existsSync(join(target.destDir, "SKILL.md"))
}

/** 解析用户输入的 ~ 前缀路径（提示文案用，不参与配置写入） */
export function expandHome(p: string): string {
  if (!isAbsolute(p) && p.startsWith("~")) return join(homedir(), p.slice(1))
  return p
}

/** npx 缓存目录提示（doctor 用） */
export function npxCacheHint(): string {
  return join(tmpdir(), "..", "npm-cache", "_npx")
}
