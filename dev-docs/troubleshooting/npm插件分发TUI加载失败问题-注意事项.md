# npm 插件分发 TUI 加载失败问题 注意事项

> 记录 0.1.0 → 0.1.2 三次发布才打通的 npm 分发链路问题。本地路径方式（`plugin: ["<仓库绝对路径>"]`）全部正常，**只有 npm 安装方式触发**，容易被验收遗漏。

## 问题现象

目标项目 opencode.json / tui.json 正确配置 `"plugin": ["@mickorz/opencode-dynamic-workflows"]`，OpenCode（1.18.29 CLI）启动后：

- ctrl+p → Plugins 的 External 列表里看不到插件
- server 侧无任何报错日志（静默失败）
- 本地路径方式在同版本下完全正常

## 根因链（三层叠加）

### 第一层：包名冲突与 npm 限制（发布环节）

- `opencode-dynamic-workflows` 裸名已被第三方（vogtsw）占用，低版本号发布会被 npm CLI 以 "previously published version is higher" 拦截（该报错发生在权限检查前，不代表有权限）
- scoped 包默认按私有包发布，免费账号报 E402，必须 `npm publish --access public`
- 新包 metadata 的 404 会被 CDN 缓存几分钟：发布成功（tarball 已可下载）但 `npm view` 404，期间 OpenCode 自动装包静默失败

### 第二层：IMPLEMENTATION_FILES 清单漏文件（0.1.1 修复）

`src/tui/index.tsx` 的"坑二"规避：npm 安装时包位于 node_modules 内，bun 忽略 tsconfig/@jsxImportSource，JSX 回退 React runtime（注册成功但不渲染），因此把实现文件 vendor 复制到 OS Temp 目录再动态 import。

问题：清单只写了 `["plugin.tsx", "workflow-store.ts"]`，而 plugin.tsx 还 import 了 `./run-snapshot-reader.js`（多树同显时新增）。文件不在 vendor 目录 → 模块解析失败 → TUI 插件加载失败。

**教训：往 src/tui 加本地实现文件时，必须同步更新 IMPLEMENTATION_FILES。**

### 第三层：Windows symlink 权限 + 软链目标层级错误（0.1.2 修复）

vendor 需要建 `node_modules` 链接回包依赖：

1. Windows 无管理员权限/开发者模式时 `symlinkSync` 抛 EPERM → `index.tsx` 顶层 await 崩溃 → 静默失败。0.1.0/0.1.1 的 vendor 目录都只有 src/ 没有 node_modules，即此因
2. 即使链建成功，原目标 `dirname(packageRoot)` 指到 `node_modules/@mickorz`（scope 目录），而依赖装在其上一级的 `<wrapper>/node_modules/`，层级差一层，永远解析不到

修复（src/tui/index.tsx）：

- `symlinkSync(target, path, "junction")` — Windows junction 免特权，POSIX 忽略 type 参数
- 目标改为 `dirname(dirname(packageRoot))`（包装 node_modules 本体）
- readlink 归一化 `\\?\` 前缀后比较，避免 junction 每次加载被误判重建

## OpenCode 1.18.29 的 npm 插件安装位置（与文档不一致）

- 官方文档说缓存于 `~/.cache/opencode/node_modules/`，**1.18.29 实际是 wrapper 结构**：
  `~/.cache/opencode/packages/<scope>/<name>/`（内含声明依赖的 package.json + node_modules/，包本体在其 node_modules/@scope/name 下）
- 安装失败不阻塞启动、日志无报错，排查只能靠目录存在性
- TUI 侧配置独立于 opencode.json：全局 `~/.config/opencode/tui.json` + 项目级 tui.json 合并生效

## 排查路径备忘（按序）

1. `npm view <pkg>` — 包是否可见（CDN 缓存期 404 假象，可用 tarball URL 直测）
2. `dir $env:USERPROFILE\.cache\opencode\packages\@mickorz\opencode-dynamic-workflows\node_modules\@mickorz\opencode-dynamic-workflows` — 包是否装全（dist、src、skills）
3. `dir $env:TEMP\opencode-dynamic-workflows-vendor-<版本>\` — **src 下 3 个实现文件 + node_modules junction 都在**才算 TUI 加载链路通过
4. 日志 `$env:USERPROFILE\.local\share\opencode\log\opencode.log`（52MB 大文件注意 tail，头部是旧记录）

## 发布 SOP

```bash
npm version patch --no-git-tag-version
npm publish --access public     # scoped 包必须 --access public
# 升级目标项目：删 packages\<scope> 缓存重启，强制重装
```

## 验收方式修正

本地路径方式（examples/sample-project）不走 vendor 分支，**验收 npm 分发必须用 npm 安装在真实目标项目跑一遍**，两者加载路径不同。

## 引用

- OpenCode 插件官方文档（安装方式/加载顺序/依赖）：https://opencode.ai/docs/plugins/
- 本仓库 AGENTS.md「TUI 插件（v1 双形态，F-20）」节：双入口 exports 与 vendor 规避的两个坑（solid-js node condition、bun JSX runtime）
- src/tui/index.tsx 头注释：坑一/坑二的规避原理与 vendor 机制设计
- Docs/02_设计与说明/TUI实时通道优化方案.md：run-snapshot-reader 引入背景（多树同显）
