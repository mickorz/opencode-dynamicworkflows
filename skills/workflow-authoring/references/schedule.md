# Schedule：定时执行 Workflow

> P1 语义：OpenCode 运行期内的定时执行。OpenCode 关闭/休眠错过的时间点不补跑；同项目多开 OpenCode 每个时间槽至多触发一次（at-most-once，原子 claim 协调）。

## 目录约定（全部在项目根 `.opencode-workflows/` 下）

```
workflows/            workflow 脚本（meta.id ?? meta.name 即 workflowId）
schedules/            定时任务配置（纯配置 JSON，运行时不写入）
schedule-claims/      触发认领（epoch 文件名，兼持久化游标，保留 7 天）
execution-locks/      执行锁（overlap=skip，run 结束释放）
runs/schedules/       执行记录（每轮一条 JSON + 独立会话）
```

## cron 四模式（P1 子集）

| 意图 | cron 示例 |
|------|-----------|
| 每 n 分钟 | `*/5 * * * *` |
| 每小时 m 分 | `30 * * * *` |
| 每天 h 点 m 分 | `0 9 * * *` |
| 每周 W 的 h 点 m 分（W 0-6，0=周日） | `0 10 * * 1`（每周一 10 点） |

其余表达式报 `INVALID_CRON`。本地时区计算。

## 工具与入口

- `/schedule <自然语言>`：command 入口（安装器拷贝模板到 `.opencode/commands/`），自然语言只用于**创建配置**，执行链路零 LLM 判断
- `schedule_create / list / get / update / delete / enable / disable / run_now`：8 个工具，`/schedule list` 等子命令复用同一批

## 触发链路（调试时按此排查）

```
tick（30s，无状态重读 schedules/*.json）
  -> latestSlot(cron, now)  最近过去 slot
  -> now - slot <= 90s？    超窗即错过（missed = skip）
  -> tryClaim(scheduleId, slot)  原子抢锁（wx）；失败静默（另一实例已认领）
  -> execution lock          被占写 skipped Record（overlap=skip）；死 pid 僵尸锁自动覆盖
  -> fresh session + 后台 run（BackgroundRunManager）
  -> Record 终态（success / failed / timeout / skipped）
```

## 定时执行的特殊行为

- **每 Run 独立会话**：不共用长会话（防 context 无限增长），结果不 prompt 回传、零额外 LLM 调用；结果摘要落执行记录，详情看 journal
- **checkpoint 即败**：无人值守无确认通道，抛 `INTERACTIVE_ACTION_REQUIRED`，run failed。需要 checkpoint 的 workflow 不适合定时跑
- **timeout**：schedule 配 `timeoutMs`，超时 abort、记录 timeout 态
- **overlap**：上一轮未结束时新一轮 skipped（P1 仅 skip 策略）

## Record 字段（runs/schedules/<scheduleId>/<epoch>-<status>.json）

`scheduleId / workflowId / workflowRunId / sessionId / status / trigger（scheduled|manual）/ scheduledAt / slotEpoch / startedAt / finishedAt / durationMs / tokens / cost / result / error`

trace 链：`scheduleId -> ScheduleRun -> workflowRunId -> journal -> phase -> agent`；workflow run 日志首行含 `trigger: schedule schedule=... scheduledAt=...`。
EOF
