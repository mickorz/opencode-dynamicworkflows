/**
 * ./tui entrypoint bootstrap（照搬 opencode-subagents-view MIT 的 tui.tsx，改中文注释）
 *
 * 本文件刻意不静态 import solid-js / @opentui/solid，也不含插件逻辑；
 * 实现在 src/tui/plugin.tsx。两个坑的规避都在本模块加载路径上，
 * 保证无论以何种方式安装，每次加载都会执行：
 *
 * 坑一（solid-js）：solid-js 的 exports map 带 "node" condition，指向无响应式的
 * SSR build（createEffect 是 no-op）。bun 默认匹配该 condition，导致信号永不更新。
 * 规避：加载时同步 patch solid-js 的 package.json——移除 "." 导出的 "node" condition。
 * 不能用 postinstall/patch-package：opencode 的 Install Plugin 不跑 lifecycle scripts。
 *
 * 坑二（JSX）：bun 对路径含 node_modules 段的文件忽略外部 tsconfig 与
 * @jsxImportSource pragma，JSX 回退 React runtime，插件注册成功但不渲染（无报错）。
 * 规避：包在 node_modules 内时，把实现文件复制到 OS temp 目录（软链回包自身
 * node_modules 保持依赖解析），从复制位置动态 import；源码开发流直接 import。
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 从指定目录出发定位 solid-js 的 package.json（require.resolve 相对自身，不受安装深度影响） */
function findSolidJsPackageJson(fromDir: string): string | undefined {
  const require = createRequire(import.meta.url)

  let resolved: string
  try {
    resolved = require.resolve("solid-js", { paths: [fromDir] })
  } catch {
    return undefined
  }

  let dir = dirname(resolved)
  while (true) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"))
      if (pkg.name === "solid-js") return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 移除 solid-js "." 导出的 "node" condition，让 bun 解析到响应式 build */
function patchSolidJsExports(fromDir: string): void {
  const pkgPath = findSolidJsPackageJson(fromDir)
  if (!pkgPath) return

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  const mainExport = pkg.exports?.["."]
  if (!mainExport || typeof mainExport !== "object" || !("node" in mainExport)) return

  delete mainExport.node
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

function isInsideNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules")
}

/** 需要一起逃逸出 node_modules 的实现文件（保持相对 import 可用）
 *  注意：必须列出 plugin.tsx 的全部本地依赖文件，漏一个就会在 vendor 目录里
 *  解析不到对应模块，TUI 插件静默加载失败（npm 安装方式才触发，路径安装不走这里） */
const IMPLEMENTATION_FILES = ["plugin.tsx", "workflow-store.ts", "run-snapshot-reader.ts"]

function vendorImplementationOutsideNodeModules(packageRoot: string, version: string): string {
  const vendorDir = join(tmpdir(), `opencode-dynamic-workflows-vendor-${version}`)
  const vendorSrcDir = join(vendorDir, "src")
  mkdirSync(vendorSrcDir, { recursive: true })

  const srcDir = join(packageRoot, "src", "tui")
  for (const file of IMPLEMENTATION_FILES) {
    writeFileSync(join(vendorSrcDir, file), readFileSync(join(srcDir, file)))
  }

  // 链回包装依赖的真实 node_modules。bun 安装结构：<wrapper>/node_modules/<pkg>，
  // 包自身在 node_modules/@scope/name，依赖（solid-js/@opentui 等）在包上两级的 node_modules。
  // 用 junction：Windows 无管理员权限建不了 symlink，junction 不需要特权；POSIX 上 type 参数被忽略。
  const vendorNodeModules = join(vendorDir, "node_modules")
  const desiredTarget = dirname(dirname(packageRoot))
  let currentTarget: string | undefined
  try {
    // Windows junction 的 readlink 可能返回 \\?\ 前缀路径，归一化后比较，避免每次重复重建
    const raw = readlinkSync(vendorNodeModules)
    currentTarget = raw.startsWith("\\\\?\\") ? raw.slice(4) : raw
  } catch {
    currentTarget = undefined
  }
  if (currentTarget !== desiredTarget) {
    rmSync(vendorNodeModules, { force: true, recursive: true })
    symlinkSync(desiredTarget, vendorNodeModules, "junction")
  }

  return join(vendorSrcDir, "plugin.tsx")
}

function resolveImplementationPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const packageRoot = dirname(dirname(here))

  patchSolidJsExports(here)

  if (!isInsideNodeModules(packageRoot)) return join(here, "plugin.tsx")

  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  return vendorImplementationOutsideNodeModules(packageRoot, pkg.version)
}

// tsc 类型检查按源码文件；运行时从上面决定的路径加载
type PluginModule = typeof import("./plugin")
const impl = (await import(resolveImplementationPath())) as PluginModule

export default impl.default
