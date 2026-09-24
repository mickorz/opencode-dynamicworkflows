# Troubleshooting

[**English**](./troubleshooting.md) | [简体中文](./zh-CN/troubleshooting.md)

> First step for any problem: run `npx @mickorz/opencode-dynamic-workflows doctor` in a terminal (read-only check printing an [OK]/[WARN]/[FAIL] list), then match the FAIL items against the sections below.

## Installation

**`workflow` missing from the tool list**

1. Confirm you edited **both** configs: `opencode.json` and `tui.json` each need a `plugin` entry
2. Confirm you **restarted OpenCode** after editing (config is only read at startup)
3. `npm view @mickorz/opencode-dynamic-workflows version` should print a version; if not, the npm registry may be flaky or the fresh release is still propagating through the CDN (retry in a few minutes)
4. Check the package cache directory exists intact: `~/.cache/opencode/packages/@mickorz/opencode-dynamic-workflows/` (Windows PowerShell: `dir $env:USERPROFILE\.cache\opencode\packages\@mickorz`)

**`workflow-authoring` missing from the skill list**

- Installed via the installer: confirm `~/.config/opencode/skills/workflow-authoring/SKILL.md` (global) or the project's `.agents/skills/` (project-level) exists, then restart OpenCode
- Configured manually: confirm `skills.paths` points at the in-package `skills` directory, and that the relative-path base is **OpenCode's startup directory** (not the config file's directory — an easy mix-up)

**Plugin not showing active in TUI / no live tree in sidebar**

- Affects the live tree only; workflow functionality itself is unaffected
- Check `tui.json` has a `plugin` entry (the TUI side is separate from opencode.json and does not inherit)

**npx reports "not recognized as a command" (git-bash)**

- Windows git-bash has issues with npm bin forwarding; run npx commands in PowerShell or cmd instead

**npx runs an old version**

- The npx cache may pin an old release. doctor warns when "CLI version behind npm latest"; force the latest with `npx @mickorz/opencode-dynamic-workflows@latest ...`

## Runtime

**Script errors about `meta`**

- The first statement must be `export const meta = { name: 'xxx', description: '...' }`, and meta must be a pure literal
- When asking the Main Agent to run a script, stress "execute exactly as-is"; markdown fences are stripped automatically

**Script errors about disabled APIs (Date.now etc.)**

- The sandbox forbids `import` / `require` / `Date.now()` / `Math.random()` / `new Date()` (deterministic-replay requirement)
- Inject timestamps and random values via the workflow tool's `args` parameter instead, read through the global `args` in scripts

**Rerunning an edited script still behaves like the old logic**

- Root cause: the `script` raw-text parameter travels through the Main Agent's context, which may reuse stale content from the previous turn's Read
- Fix: pass a file path via scriptPath instead (the server reads the file at execution time, guaranteed current on disk):
  `Execute scripts/xxx.js with the workflow tool, scriptPath = that path`
- The `script` raw-text parameter still works; passing both or neither errors out

**Agent reports `agent "x" timed out (ms)`**

- Raise or omit the agent's `timeoutMs` (omitted with no run-level default means no hard timeout); adjust run-wide via the `agentTimeoutMs` tool arg
- Note timeouts consume `retries`: if retries also time out, the task itself is too slow — split it or switch models first

**Agents return null (or everything null)**

- After a recoverable failure (network/timeout/rate-limit) exhausts retries, the agent returns null without throwing — one rerun usually fixes it; if frequent, add `agentRetries: 2` (cap 3)
- For fail-fast semantics on a single agent, don't put it in `parallel` — `await agent(...)` directly

**Agent reports `agent model must be provider/modelId format`**

- The `model` parameter must be the full `"provider/modelId"` (e.g. `openai/gpt-4o-mini`); bare `modelId` is rejected
- Don't know your provider prefix? Look at how the `model` field is written in `opencode.json` and copy the prefix

**Log shows `tier "xxx" not configured, falling back to session default model`**

- The tier name is missing from config: add the key in global `~/.config/opencode/workflows/model-tiers.json` or project `.opencode-workflows/model-tiers.json` (non-fatal; just falls back to the default model)

**Schema-mode agent fails outright (provider_bad_request / 400)**

- Structured output relies on the model supporting tool_choice required; some gateways/models don't (some OpenAI-compatible gateways return 400 in practice)
- Switch to a model that supports structured output, or drop `schema` and parse natural-language output

**File-writing tasks "complete with no effect"**

- `agent()` defaults to the read-only explore sub-agent. Writing files requires `agentType: 'general'` explicitly; for parallel writers not clobbering each other, add `isolation: 'worktree'`

**Background task keeps running after Esc**

- Foreground workflows cancel fully on Esc (abort cascades); but background runs started with `background: true` are **unaffected by Esc** (by design) — stop them with the `workflow_control` tool: `{ "action": "stop", "runId": "run-xxx" }`

**Resume reports "journal for run not found"**

- Journals persist under the project directory where OpenCode **was started**: `.opencode-workflows/journal/<runId>.json`; starting from another directory breaks the lookup — return to the original directory or omit `resumeFromRunId` to start fresh

## Confirmed Non-Bugs

| Symptom | Explanation |
| ------- | ----------- |
| No intermediate sub-task output in the main conversation | By design: context isolation. Details live in sub-sessions; inspect via subagent navigation inside the parent |
| Sub-sessions absent from the session list | The platform filters child sessions; enter via subagent navigation from the parent |
| Main Agent only says "see the JSON output above" | The synthesized result is in the tool output's `## Result` JSON block; to expand it, say "repeat the overview from the result in full" |
| Agent summary status `[cached]` | The result was replayed from a previous run's journal (resume / rerun of unchanged parts) — no tokens spent |
| Clicking into a schema node's sub-session shows a blank body | Normal shape for structured output: the result lives in the StructuredOutput tool call, not the assistant body. The workflow return value and journal hold the complete result — trust those |
| Result JSON ends with "result too large, truncated" | Tool output has a 50KB platform budget; the full structure remains in metadata |

## Still Stuck

1. Collect the full `doctor` output
2. Grab the tail of the OpenCode log: `%USERPROFILE%\.local\share\opencode\log\opencode.log` (Linux/macOS: `~/.local/share/opencode/log/`)
3. File an issue at [GitHub Issues](https://github.com/mickorz/opencode-dynamicworkflows/issues) with the above and reproduction steps
