#!/usr/bin/env node
/**
 * OpenCode Dynamic Workflows CLI 入口
 *
 * 命令分发结构：
 *
 * npx @mickorz/opencode-dynamic-workflows <命令>
 *   │
 *   ├─> install（默认） 交互式安装
 *   │     ├─> 检测 OpenCode 版本（失败仅警告）
 *   │     ├─> 第一步 选择安装方式（全局 / 当前项目 / 锁定版本）
 *   │     ├─> 第二步 是否安装 skill
 *   │     └─> 确认后 合并两份 json 配置 + 拷贝 skill
 *   │
 *   ├─> update        插件本体与 skill 升级
 *   │     ├─> 检测安装方式存在性
 *   │     ├─> 当前版本对比 npm 最新
 *   │     └─> 确认后 清缓存 / npm update / skill 覆盖拷贝
 *   │
 *   ├─> uninstall     交互式卸载
 *   │     ├─> 检测三种方式存在性（零种提示退出 / 多种 multiselect）
 *   │     └─> 确认后 移除配置条目 + 清理 skill 目录（逐个确认）+ 可选 npm uninstall
 *   │
 *   ├─> doctor        环境排查（只读，输出 OK/WARN/FAIL 清单）
 *   └─> help          帮助
 */

import { runInstall } from "./install.js"
import { runUpdate } from "./update.js"
import { runUninstall } from "./uninstall.js"
import { runDoctor } from "./doctor.js"

const HELP = `
OpenCode Dynamic Workflows CLI

用法：npx @mickorz/opencode-dynamic-workflows <命令>

命令：
  install      交互式安装（默认）
  update       插件本体与 skill 升级到最新
  uninstall    交互式卸载（先检测存在项再勾选卸载）
  doctor       环境排查（只读）
  help         显示本帮助
`

async function main(): Promise<void> {
  const command = process.argv[2]?.toLowerCase() ?? "install"

  switch (command) {
    case "install":
      await runInstall()
      break
    case "update":
      await runUpdate()
      break
    case "uninstall":
      await runUninstall()
      break
    case "doctor":
      await runDoctor()
      break
    case "help":
    case "--help":
    case "-h":
      console.log(HELP)
      break
    default:
      console.log(`未知命令：${command}`)
      console.log(HELP)
      process.exitCode = 1
  }

}

main().catch((error) => {
  console.error(`CLI 执行出错：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
