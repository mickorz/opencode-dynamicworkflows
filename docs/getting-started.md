# Getting Started: From Zero to Your First Workflow

[**English**](./getting-started.md) | [简体中文](./zh-CN/getting-started.md)

> Written for readers brand new to this project. The tutorial takes about 10 minutes; at the end you will have run a workflow with 3 sub-agents working in parallel and will be able to read every part of its output.

## 0. What You Will Accomplish

Say "analyze these files in parallel" to the AI, and the plugin will:

1. Have the Main Agent generate an orchestration script (you write no code)
2. Execute the script in a sandbox, dispatching tasks to multiple independent sub-sessions running **in parallel**
3. Show a live progress tree in the TUI sidebar
4. Return only the **aggregated result** plus per-task timing/token stats to the main conversation — intermediate processes never pollute your chat context

## 1. Prerequisites

| Requirement | Details | How to check |
| --- | --- | --- |
| OpenCode v1 | Installed with a working provider/model (normal conversation) | `opencode --version` prints 1.x |
| provider/model | Chat works inside OpenCode | Ask it anything |
| Node.js 18+ and npm | Only needed for the npx installer and npm operations | `node --version` prints v18+ |

If OpenCode isn't installed, see the [official docs](https://opencode.ai/docs/). Windows users: run all npx commands below in PowerShell or cmd.

## 2. Install the Plugin

Run in any directory:

```powershell
npx @mickorz/opencode-dynamic-workflows install
```

The interactive flow:

1. Detects the OpenCode version (confirms if not v1)
2. Choose an install mode — for a first install choose **global** (works for all projects)
3. Install the skill? — choose **yes** (workflow-authoring is the manual the Main Agent uses to write scripts)
4. Confirm the change list and execute; the original config is backed up as `.bak`

The installer modifies two config files (adds one `plugin` entry each to `opencode.json` and `tui.json`) and copies two skills to `~/.config/opencode/skills/`.

## 3. Restart and Verify

**Restart OpenCode** (config is only read at startup), then:

1. Ask the Main Agent: `What tools do you have?` — `workflow` should be in the list
2. Ask: `What skills do you have?` — `workflow-authoring` should appear
3. (Optional) In the TUI, ctrl+p → Plugins — the plugin should show active; from then on, every workflow run gets a live progress tree in the sidebar
4. (Optional) Run `npx @mickorz/opencode-dynamic-workflows doctor` in a terminal — everything should be [OK]:

```
[OK] Node.js v24.18.0
[OK] npm 11.16.0
[OK] OpenCode 1.18.30
...
Check complete: N OK, 0 WARN, 0 FAIL
```

If `workflow` or the skill is missing, jump straight to [troubleshooting](troubleshooting.md).

## 4. Run Your First Workflow

Paste this to the Main Agent as-is:

```
Execute the following script with the workflow tool, exactly as-is:

export const meta = { name: 'smoke_test', description: 'minimal smoke: 3 agents' }

phase('Scan')
const info = await agent('List the files in your current directory, output only the first 10 lines')

phase('Echo')
const results = await parallel([
  () => agent('Explain workflow orchestration in one sentence'),
  () => agent('Explain deterministic replay in one sentence'),
])
return { info, results }
```

What this script means: first one agent lists the directory (Scan phase), then two agents answer two questions in parallel (Echo phase), and finally the three results are packed up and returned.

A live tree appearing in the sidebar during the run is normal; the whole script usually finishes within tens of seconds.

## 5. Read the Result

The tool output has four parts:

```
Workflow smoke_test completed: 3 agents, 11.6s, 612 tokens total (runId: run-xxxxxxx)
Phases: Scan > Echo

Agent summary:
  [ok] <task name> (Scan) 120 tok ($0.0012)
  [ok] <task name> (Echo) 96 tok ($0.0009)
  [ok] <task name> (Echo) 88 tok ($0.0008)

## Result
{ "info": "...", "results": ["...", "..."] }
```

(Values vary by model; the cost column appears only when the provider returns cost data.)

- **Header stats**: total agents, failures/aborts, total duration, total tokens, and the runId (used for resuming and progress queries)
- **Agent summary**: one line per sub-session — status (ok/failed/aborted/cached), phase, token usage; `[cached]` means the result was replayed from a previous run's journal and cost no tokens
- **`## Result`**: the value your script `return`ed (JSON) — this is the actual output you care about
- **Footer hint**: `Tip: iterate without re-burning tokens — pass resumeFromRunId=... after editing the script`, the entry point for resuming; see [how-to-guides](how-to-guides.md)

Two things you *don't* see are **by design**, not bugs:

1. The main conversation shows only one tool call and one result — no intermediate sub-session output. That is the entire point of the plugin (context isolation). To see what a sub-task did, use subagent navigation inside the parent session.
2. Sub-sessions don't appear in the normal session list (the platform filters child sessions); enter them the same way, via subagent navigation from the parent.

One step further: sub-tasks can pick a different `model` and constrain returns to JSON with `schema` — see the corresponding chapters in [how-to-guides](how-to-guides.md).

## 6. Try a Second One: the Natural-Language Version

Above you handed over a script manually; in everyday use you just state the goal and the Main Agent generates the script itself:

```
Use workflow to analyze the core content of all markdown files under the docs directory in parallel, then summarize into a bullet-point list
```

Watch the script it generates and you'll notice a fixed pattern: `phase` to split stages → `parallel` for parallel analysis → one final agent to synthesize. This "fan-out and synthesize" shape is the most common form for this plugin; more examples live in the skill's built-in [fan-out-and-synthesize.js](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/examples/fan-out-and-synthesize.js).

## 7. Next Steps and Getting Help

- Background long tasks, resume, quality DSL, file-writing tasks → [docs/how-to-guides.md](how-to-guides.md)
- Three install modes, upgrade & uninstall → [docs/configuration.md](configuration.md)
- Something broke → [docs/troubleshooting.md](troubleshooting.md)
- Every DSL API → [workflow-authoring DSL reference](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md)
