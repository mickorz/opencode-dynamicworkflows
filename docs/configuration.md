# 配置参考：安装方式、配置字段、升级与卸载

> 本页是配置的权威参考。第一次安装只需要 [npx install 一条命令](getting-started.md)，本页供需要精细控制的场景。

## 三种安装方式对比

| 方式 | 生效范围 | 版本管理 | 适用场景 |
|------|---------|---------|---------|
| 一：全局安装（推荐） | 所有项目 | OpenCode 全局缓存，删缓存升级 | 个人机器统一用最新 |
| 二：项目级包名 | 单项目 | OpenCode 全局缓存 | 仅个别项目启用 |
| 三：项目 node_modules 锁定 | 单项目 | 项目 package.json 锁定 | 团队协作、离线/内网、版本一致性要求高 |

安装器（`npx @mickorz/opencode-dynamic-workflows install`）覆盖以上三种，交互选择后自动完成配置合并（JSONC 增量合并，保留注释与格式）与 skill 拷贝，修改过的配置文件留 `.bak` 备份。以下为各方式的手动配置等价物。

### 方式一：全局安装

`~/.config/opencode/opencode.json`（server 侧）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

`~/.config/opencode/tui.json`（TUI 侧，**必须独立配置**，不会从 opencode.json 继承）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

全局模式下 skill 由安装器拷贝到 `~/.config/opencode/skills/`（OpenCode 原生扫描目录），无需额外配置。

> 无需手动 `npm install` 本包：OpenCode 启动时检测到 `plugin` 里的包名会自动从 npm 拉取并缓存到 `~/.cache/opencode/packages/`。

### 方式二：项目级包名

发给同事或不打算全局生效时，在目标项目根目录放两份配置：

`opencode.json`：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json`（与 opencode.json 同目录）：

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

> 项目级 `skills.paths` 需要先在项目里 `npm install @mickorz/opencode-dynamic-workflows`。**相对路径基准**：`plugin` 相对配置文件所在目录解析；`skills.paths` 相对 OpenCode 启动目录解析。

### 方式三：项目 node_modules 锁定（团队协作推荐）

```bash
cd 你的项目
npm install @mickorz/opencode-dynamic-workflows
```

版本写入 package.json 随 git 提交，团队成员 `npm install` 后即用。配置里不写包名，写相对路径引用：

`opencode.json`：

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json`：

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"]
}
```

## 配置字段说明

| 字段 | 位置 | 取值 | 说明 |
|------|------|------|------|
| `plugin` | opencode.json | 包名（方式一/二）或 `./node_modules/...` 相对路径（方式三） | server 侧加载包内 `dist/index.js`，注册 `workflow` 与 `workflow_control` 工具 |
| `plugin` | tui.json | 同上 | TUI 侧经包内 `exports["./tui"]` 加载 sidebar 实时树。**漏配只丢实时树，不影响工作流功能** |
| `skills.paths` | opencode.json | 包内 `skills` 目录 | 手动配置时挂载 workflow-authoring / workflow-optimize skill；用安装器时不需要（已拷贝到 skill 标准目录） |

skill 的两个落位机制二选一即可：安装器**拷贝**到 `~/.config/opencode/skills/`（全局）或 `.agents/skills/`（项目），或手动配置 `skills.paths` **引用**包内目录。重复配置不冲突，但没必要。

## 生效与验证

- 任何配置改动后**必须重启 OpenCode**（配置只在启动时读取）
- 验证：问 Main Agent "你有哪些工具？"应见 `workflow`；ctrl+p → Plugins 应见本插件 active

## 升级

| 安装方式 | 升级方法 |
|---------|---------|
| 一（全局） | `npx @mickorz/opencode-dynamic-workflows update`，或删缓存后重启自动拉最新（见下） |
| 二（项目级包名） | 同上（与方式一共享全局缓存） |
| 三（锁定版本） | `npm update @mickorz/opencode-dynamic-workflows`，无需清 OpenCode 缓存 |

方式一/二手动清缓存（PowerShell）：

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.cache\opencode\packages\@mickorz
```

bash 等价：

```bash
rm -rf ~/.cache/opencode/packages/@mickorz
```

> npx 自身也有缓存且可能钉住旧版本（doctor 会 WARN 提示）。需要强制用最新版安装器时运行 `npx @mickorz/opencode-dynamic-workflows@latest ...`。

## 卸载

```powershell
npx @mickorz/opencode-dynamic-workflows uninstall
```

交互式检测三种安装方式的存在项（零种直接退出，多种可勾选），逐项移除配置条目、清理拷贝的 skill，锁定模式可选一并 `npm uninstall`。只剩空壳的配置文件会整文件删除。

## 缓存与日志位置（排障参考）

| 内容 | 位置 |
|------|------|
| OpenCode 拉取的插件包 | `~/.cache/opencode/packages/@mickorz/opencode-dynamic-workflows/` |
| OpenCode 日志 | `~/.local/share/opencode/log/opencode.log`（Windows：`%USERPROFILE%\.local\share\opencode\log\`，大文件注意取尾部） |
| 工作流 journal（断点续跑数据） | 项目目录下 `.opencode-workflows/journal/<runId>.json` |
