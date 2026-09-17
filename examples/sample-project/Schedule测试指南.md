# Schedule 定时任务测试指南

> 验收 `opencode-dynamic-workflows` v0.7.0 的 Schedule 功能（P1：OpenCode 运行期内调度）。
> 前置：本插件已安装并重新构建（`npm run build`），示例工程已带 workflow 脚本
> `.opencode-workflows/workflows/schedule-test.js`。

## 验收清单

### Test 1：每分钟自动执行（基础链路）

1. 在本目录启动 OpenCode
2. 输入：`/schedule 每分钟执行 schedule-test.js`
3. 确认回显含 `Cron: */1 * * * *`、`Next run`、`Requires OpenCode running: Yes`
4. 等待 2-3 个分钟整点

**通过标准**：
- `.opencode-workflows/runs/schedules/<scheduleId>/` 下出现 2-3 条 `success` 记录
- OpenCode 会话列表每轮多出一个 `schedule-test · <时间>` 独立会话（点开可见 agent 子树）
- 说"查看定时任务"（schedule_list）能看到 last: success @ 时间

### Test 2：TUI 重启恢复

1. 保持 Test 1 的 schedule 存在，重启 OpenCode
2. 等待下一个整点

**通过标准**：到点正常执行；重启前的历史 slot 不补发（不出现成批补跑）。

### Test 3：Multi-TUI 双开不重复（核心验收）

1. 同一本目录开两个 OpenCode TUI 窗口
2. 建 `*/1` 的 schedule（或沿用 Test 1）
3. 连续观察 5 个整点

**通过标准**：
- 每个整点恰好产生 1 条新 Record（success），共 5 条
- 无重复执行；无成片的 skipped 噪音记录（skipped 只属于真 overlap）
- 可对照 `.opencode-workflows/schedule-claims/<scheduleId>/`：每个 slot 恰好一个 claim 文件

### Test 4：overlap skip（上一轮没跑完）

1. 把 workflow 换成耗时超过 1 分钟的（脚本里 `await checkpoint` 不行——见 Test 6；可让 agent 做长任务并设大 `--timeout`），或直接建 `*/1` + `timeoutMs: 300000`
2. 观察第二轮触发点

**通过标准**：第二轮 Record 为 `skipped`，error 含 `overlapPolicy=skip`。

### Test 5：checkpoint 即败

1. 临时建 workflow：`export const meta = { name: 'cp-test' }\nconst ok = await checkpoint('需要确认')\nreturn ok`
2. 对它建 schedule 并 `run-now`（说"立即执行一次 cp-test 的定时任务"）

**通过标准**：Record 为 `failed`，error 含 `INTERACTIVE_ACTION_REQUIRED`。

### Test 6：timeout

1. 建长任务 workflow（agent 慢任务），schedule 配 `timeoutMs: 300000` 之外另建一个 `timeoutMs` 很短的测试项（如 60000）
2. `run-now`

**通过标准**：短超时项 Record 为 `timeout`，error 含 `timeoutMs`；锁文件已释放（`execution-locks/` 下无残留）。

### Test 7：错过 = skip

1. 建一个每天 9 点的 schedule
2. 把系统时间/等待跨过整点超过 90 秒后再观察（或临时调系统时间）

**通过标准**：超过宽容期（90s）的 slot 不执行、不补跑；下一个未来 slot 正常。

### Test 8：workflow 缺失

1. 删除 `.opencode-workflows/workflows/schedule-test.js`
2. 说"查看定时任务"

**通过标准**：schedule_list 在对应条目标 `[警告: workflow 文件缺失]`；run-now 报 `WORKFLOW_NOT_FOUND`。

### Test 9：disable 后不动

1. 说"停用 xxx 定时任务"（schedule_disable）
2. 跨过触发点

**通过标准**：无新 Record；schedule_list 显示停用且无 next；说"启用 xxx"后恢复。

## 常见排查

| 现象 | 检查 |
|------|------|
| 到点没跑 | 插件是否重新加载（重启 OpenCode）；`.opencode-workflows/schedules/` 配置是否存在且 enabled |
| 每轮跑两次 | 是否两个项目目录各一套（按项目隔离是正常的）；确认不是同项目双开却无 claim（升级到 v0.7.0+） |
| Record 一直 running | 查 `execution-locks/` 是否有死锁残留（正常会自动清）；查 workflow 是否卡住（workflow_control status） |
| /schedule 命令不存在 | 重跑 npx 安装器拷贝 command 模板到 `.opencode/commands/` |
