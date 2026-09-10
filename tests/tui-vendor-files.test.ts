/**
 * TUI vendor 文件登记守卫测试（Node Inspector 防坑）
 *
 * src/tui/index.tsx 的 IMPLEMENTATION_FILES 是 npm 安装方式下 TUI 的
 * vendor 复制清单：新增实现文件漏登记会在 node_modules 安装场景静默加载失败
 * （bun 对 node_modules 内文件忽略 JSX pragma，必须逃逸复制）。
 * 本测试断言 src/tui/ 下除 index.tsx 外的每个实现文件都已在清单里。
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const TUI_DIR = path.join(import.meta.dirname, "..", "src", "tui")

test("src/tui 实现文件全部登记在 IMPLEMENTATION_FILES", () => {
  const bootstrap = fs.readFileSync(path.join(TUI_DIR, "index.tsx"), "utf8")
  const match = bootstrap.match(/const IMPLEMENTATION_FILES = \[([^\]]*)\]/)
  assert.ok(match, "index.tsx 应有 IMPLEMENTATION_FILES 数组")
  const listed = new Set(
    Array.from(match![1].matchAll(/"([^"]+)"/g), (m) => m[1]),
  )
  assert.ok(listed.size > 0, "清单非空")

  const onDisk = fs
    .readdirSync(TUI_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name) && name !== "index.tsx")
  const missing = onDisk.filter((name) => !listed.has(name))
  assert.deepEqual(
    missing,
    [],
    `以下 TUI 实现文件未登记 IMPLEMENTATION_FILES（npm 安装下会静默失败）：${missing.join(", ")}`,
  )
  // 反向：清单里的文件都真实存在（防改名后留死条目）
  const stale = Array.from(listed).filter((name) => !fs.existsSync(path.join(TUI_DIR, name)))
  assert.deepEqual(stale, [], `清单登记了不存在的文件：${stale.join(", ")}`)
})
