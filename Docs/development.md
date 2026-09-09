# 贡献者指南

> 用户文档见 [getting-started](getting-started.md) 等页面；本页面向要改代码的贡献者。AI 编码规则的唯一事实来源是根目录 [AGENTS.md](../AGENTS.md)，本页只做人类视角的摘要与操作指引。

## 环境与常用命令

```bash
npm install
npm run build       # 产出 dist/（server 侧）
npm run typecheck   # tsc --noEmit（server + test + tui 三个 tsconfig）
npm test            # node:test + tsx，106 个用例（3~4 秒，不调真实 LLM）
```

- 要求 Node.js 18+；CI（发布流水线）在 Node 22 上跑 typecheck + test 后发布
- TUI 侧无构建产物：OpenCode 内置运行时直接读 `src/tui` 源码

## 架构速览

```
src/
├─ index.ts        # 插件入口（薄层）：注册 workflow / workflow_control 两个 tool
├─ runtime/        # 工作流执行核心：VM 沙箱、并发信号量、错误分类 —— 宿主无关
├─ agent/          # AgentSessionRunner 接口 + 模型分层
├─ adapters/       # OpenCode SDK 只允许出现在这里（OpenCodeSessionAdapter）
├─ tools/          # 工具实现：workflow、workflow_control、结果渲染、运行快照、后台 run
├─ tui/            # TUI 侧插件（sidebar 实时树）
├─ cli/            # npx 安装器：install / update / uninstall / doctor
├─ persistence/    # journal（断点续跑数据）
└─ isolation/      # git worktree 隔离
```

关键约束（详见 AGENTS.md）：

- `src/runtime/` 禁止 import OpenCode SDK——Runtime 必须宿主无关；正确链路 `runtime → AgentSessionRunner 接口 → OpenCodeSessionAdapter → client.session.*`
- `src/index.ts` 只做依赖初始化与注册，不放业务逻辑
- child session 一律经 Adapter 创建
- TUI 侧 solid-js 用法只允许出现在 `src/tui/plugin.tsx` 单文件（多文件会解析出不同 solid-js 实例）；纯数据逻辑拆 ts
- 注释与日志用中文，禁止 emoji，文件 UTF-8

## 测试

- 框架：node:test + tsx；runtime 测试注入 fake runner（countingAgent / deferredAgent / deferred gate 模式），不 mock HTTP
- worktree 相关测试跑真实 git
- 新脚本/新逻辑按项目规范补同名 `xxx.test.ts`；测试注入点在 `AgentSessionRunner` 接口缝上

## 本地联调

`examples/sample-project/` 是自包含的手工验收工程：

```
cd examples/sample-project
opencode
```

- 该目录的 `opencode.json` / `tui.json` 以相对路径 `"../.."` 指向仓库根，自动加载本仓库的插件与 skills
- `plugin` 相对配置文件所在目录解析；`skills.paths` 相对 OpenCode 启动目录解析——在本目录启动两者一致，无需绝对路径
- 改 server 侧代码后需 `npm run build` 再重启 OpenCode；改 TUI 侧重启即生效
- 验收脚本在 `examples/sample-project/scripts/`，用法见 [docs/testing.md](testing.md) 与目录内测试指南

## 发布

CI 打 `v*` tag 自动发布到 npm（`.github/workflows/publish.yml`）：

```bash
npm version patch        # 改版本号 + 提交 + 打 tag（如 v0.2.2）
git push --follow-tags   # tag 推送触发流水线：typecheck + test 通过后 npm publish
```

流水线会校验 tag 与 package.json 版本一致，防止发错版本。

## 文档维护

- 用户文档在本目录（`docs/`），README 只保留定位、安装、快速开始与文档地图
- DSL API 的权威描述在 `skills/workflow-authoring/references/runtime.md`（随 npm 包分发给 Main Agent），用户文档只链接不复制，避免双源漂移
- 文档中的命令与输出必须实跑验证后再写入；版本相关表述避免写死第三方版本号
