---
description: "创建或管理 Workflow 定时任务（Schedule）：如 /schedule 每小时执行 xxx.js、/schedule list"
---

# schedule

用户输入：$ARGUMENTS

按以下规则处理（注意：只解析意图并调用工具，不要自己写 cron 文件或执行 workflow）：

## 意图 1：创建定时任务

句式特征：包含"每 N 分钟/每小时/每天 HH 点/每周 X"等定时描述 + 要执行的 workflow。

先读取 `.opencode-workflows/workflows/` 目录下用户提到的脚本（或按文件名匹配），确认其 `export const meta = { name: ... }` 里的 name（或 id），然后把自然语言定时翻译成 cron：

- "每 N 分钟" -> `*/N * * * *`
- "每小时" -> `0 * * * *`；"每小时第 m 分" -> `m * * * *`
- "每天 HH 点" -> `0 HH * * *`；"每天 HH 点 m 分" -> `m HH * * *`
- "每周一" -> `0 9 * * 1`（未说时间默认 9 点，并向用户确认）；周几映射：周一=1 ... 周六=6 周日=0

然后调用 `schedule_create` 工具（参数 workflowId、cron、可选 name/args），并把工具返回的结果**原样**展示给用户（其中包含 Next run 与 Requires OpenCode running 边界说明）。

若用户提到的脚本不存在于 `.opencode-workflows/workflows/`，先告知用户需要把 workflow 脚本放到该目录后再创建，不要凭空创建。

## 意图 2：查看

"list / 列表 / 有哪些定时任务" -> 调用 `schedule_list` 工具并原样展示结果。

## 意图 3：其他管理操作

disable / enable / delete / run-now / update 等操作当前版本暂未提供工具，直接告知用户对应的配置文件位置（`.opencode-workflows/schedules/<id>.json`）与可手动修改的字段。

## 边界提醒（创建成功后必须保留在回复里）

- Requires OpenCode running: Yes —— OpenCode 关闭期间任务不执行
- 错过的时间点不补跑，下一个未来时间点正常执行
