# Configuration Reference: Install Modes, Config Fields, Upgrade & Uninstall

[**English**](./configuration.md) | [简体中文](./zh-CN/configuration.md)

> This page is the authoritative configuration reference. First-time installs only need the [one-command npx install](getting-started.md); this page is for fine-grained control.

## Three Install Modes Compared

| Mode | Scope | Version management | Best for |
| ---- | ----- | ------------------ | -------- |
| 1. Global (recommended) | All projects | OpenCode global cache; clear cache to upgrade | Personal machines on latest |
| 2. Project-level package name | One project | OpenCode global cache | Enabling for select projects |
| 3. Project node_modules pinned | One project | Pinned in package.json | Team collaboration, offline/intranet, strict version consistency |

The installer (`npx @mickorz/opencode-dynamic-workflows install`) covers all three: after interactive selection it merges configs automatically (incremental JSONC merge preserving comments and formatting), copies skills, and leaves `.bak` backups of modified files. Below are the manual equivalents for each mode.

### Mode 1: Global Install

`~/.config/opencode/opencode.json` (server side):

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

`~/.config/opencode/tui.json` (TUI side, **must be configured separately** — not inherited from opencode.json):

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

In global mode the installer copies skills to `~/.config/opencode/skills/` (OpenCode's native scan directory); no extra config needed.

> No manual `npm install` of this package needed: on startup OpenCode detects the package name in `plugin`, fetches it from npm, and caches it under `~/.cache/opencode/packages/`.

### Mode 2: Project-Level Package Name

For handing to colleagues or when you don't want global effect, put two config files in the target project root:

`opencode.json`:

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json` (same directory as opencode.json):

```json
{
  "plugin": ["@mickorz/opencode-dynamic-workflows"]
}
```

> Project-level `skills.paths` requires `npm install @mickorz/opencode-dynamic-workflows` in the project first. **Relative-path bases**: `plugin` resolves relative to the config file's directory; `skills.paths` resolves relative to OpenCode's startup directory.

### Mode 3: Project node_modules Pinned (Recommended for Teams)

```bash
cd your-project
npm install @mickorz/opencode-dynamic-workflows
```

The version lands in package.json and travels with git; teammates just `npm install`. The config references the relative path instead of the package name:

`opencode.json`:

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"],
  "skills": {
    "paths": ["node_modules/@mickorz/opencode-dynamic-workflows/skills"]
  }
}
```

`tui.json`:

```json
{
  "plugin": ["./node_modules/@mickorz/opencode-dynamic-workflows"]
}
```

## Config Field Reference

| Field | File | Value | Description |
| ----- | ---- | ----- | ----------- |
| `plugin` | opencode.json | Package name (modes 1/2) or `./node_modules/...` relative path (mode 3) | Server side loads `dist/index.js` from the package, registering the `workflow` and `workflow_control` tools |
| `plugin` | tui.json | Same as above | TUI side loads the sidebar live tree via the package's `exports["./tui"]`. **Missing it only loses the live tree, workflows still work** |
| `skills.paths` | opencode.json | The package's `skills` directory | Mounts the workflow-authoring / workflow-optimize skills when configuring manually; unnecessary with the installer (already copied to the standard skill directory) |

The two skill placement mechanisms are either-or: the installer **copies** to `~/.config/opencode/skills/` (global) or `.agents/skills/` (project), or you configure `skills.paths` to **reference** the in-package directory. Duplication doesn't conflict but is pointless.

## Taking Effect & Verification

- After any config change you **must restart OpenCode** (config is only read at startup)
- Verify: ask the Main Agent "what tools do you have?" — `workflow` should appear; ctrl+p → Plugins should show this plugin active

## Upgrade

| Install mode | How to upgrade |
| ------------ | -------------- |
| 1 (global) | `npx @mickorz/opencode-dynamic-workflows update`, or clear cache and restart to auto-pull latest (below) |
| 2 (project package name) | Same as mode 1 (shares the global cache) |
| 3 (pinned) | `npm update @mickorz/opencode-dynamic-workflows`, no OpenCode cache clearing needed |

Clearing the cache manually for modes 1/2 (PowerShell):

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.cache\opencode\packages\@mickorz
```

bash equivalent:

```bash
rm -rf ~/.cache/opencode/packages/@mickorz
```

> npx itself also caches and may pin an old version (doctor warns). To force the latest installer, run `npx @mickorz/opencode-dynamic-workflows@latest ...`.

## Uninstall

```powershell
npx @mickorz/opencode-dynamic-workflows uninstall
```

Interactively detects which of the three modes exist (exits if none, checkboxes when several), removes config entries one by one, cleans copied skills, and optionally `npm uninstall` for pinned mode. Config files left as empty shells get deleted entirely.

## Cache & Log Locations (Troubleshooting Reference)

| Item | Location |
| ---- | -------- |
| Plugin package fetched by OpenCode | `~/.cache/opencode/packages/@mickorz/opencode-dynamic-workflows/` |
| OpenCode logs | `~/.local/share/opencode/log/opencode.log` (Windows: `%USERPROFILE%\.local\share\opencode\log\`; mind the tail on big files) |
| Workflow journal (resume data) | `.opencode-workflows/journal/<runId>.json` under the project directory |
