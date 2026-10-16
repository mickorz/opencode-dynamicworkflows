# Bun CJS Interop 与 meta 命名——Schedule 手工验收踩坑记录

## 现象

手工验收 `/schedule 每分钟执行 schedule-test.js` 时连续两个报错：

1. `meta.name 必须是非空的 snake_case 字符串`——`schedule-test` 含连字符被拒（vm.ts:161 既有校验，非 Schedule 引入）
2. 修复命名后 schedule_create 仍失败——`cronParser.CronExpressionParser` 为 undefined

## 根因

OpenCode 插件进程由 **Bun** 加载（bun 直读 dist/server 侧 JS）。cron-parser 5.10.1 是 CJS 包（package.json `type: commonjs`），Bun 的 ESM/CJS interop 与 Node 不同：

```js
// Node（测试环境）：
import cronParser from "cron-parser"
cronParser.CronExpressionParser   // OK：default = module.exports 对象

// Bun（插件运行环境）：
import cronParser from "cron-parser"
typeof cronParser                  // "function"！default 指向构造器本身
cronParser.CronExpressionParser    // undefined -> 运行时炸
```

**同一份代码在 node:test 全绿、在 Bun 插件进程内崩**——测试覆盖不到运行时 interop 差异。

## 修复

```ts
// 之前（Node 可用，Bun 不可用）
import cronParser from "cron-parser"
cronParser.CronExpressionParser.parse(...)

// 之后（双环境一致）
import { CronExpressionParser } from "cron-parser"
CronExpressionParser.parse(...)
```

## 规则（后续新增依赖必查）

1. 插件进程（src/ 除 src/cli/）内 import CJS 依赖：一律用具名导入或 `import * as ns`，**禁止 default import**；TS 能过不代表 Bun 能跑
2. cli/ 下用 node 跑，default import 无碍（现有 jsonc-parser/clack 均安全）
3. 验收顺序：改完必须 `npm run build` + **重启 OpenCode**（插件进程缓存旧 dist，rebuild 不热更新）
4. workflow `meta.name` 必须 snake_case（vm.ts 校验）：示例/文档里的 workflowId 不要带连字符

## 本库外部依赖导入点清单（2026-09 核查全绿）

| 依赖 | 位置 | 导入方式 | 环境 |
|------|------|---------|------|
| acorn | src/runtime/vm.ts | 具名 `{ parse }` | Bun（插件）+ Node（测试） |
| cron-parser | src/schedule/cron.ts | 具名 `{ CronExpressionParser }`（本次修复） | 同上 |
| jsonc-parser | src/cli/config.ts | 具名 | Node（CLI） |
| @clack/prompts | src/cli/* | namespace | Node（CLI） |

新增运行时依赖时同步维护此表。
