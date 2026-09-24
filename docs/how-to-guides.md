# How-To Guides: Model Orchestration, Schema Output, Timeouts & Retries, Parameters, Background Runs, Resume, Quality DSL, Worktree Isolation

[**English**](./how-to-guides.md) | [简体中文](./zh-CN/how-to-guides.md)

> Six independent recipes — pick what you need. For authoritative details on every DSL parameter and semantic, see the [workflow-authoring DSL reference](https://github.com/mickorz/opencode-dynamicworkflows/blob/main/skills/workflow-authoring/references/runtime.md).

## Model Orchestration (model / tier)

**Scenario**: sub-tasks differ in difficulty — classification, summaries, and format conversion on a cheap model; core generation (DSL, code, review) on a strong model. Saves money without sacrificing quality.

```javascript
// Option 1: explicit model, must be the full "provider/modelId" format
const outline = await agent('Generate the outline', { model: 'openai/gpt-4o-mini' })

// Option 2: configure model-tiers.json first, then reference tiers by name in
// scripts (recommended — swap models without touching scripts)
const draft = await agent('Write the body', { tier: 'big' })
```

The tier config file (JSON) — global at `~/.config/opencode/workflows/model-tiers.json`, project-level at `.opencode-workflows/model-tiers.json` (same-name keys override global):

```json
{
  "tiers": {
    "small": "openai/gpt-4o-mini",
    "big": "anthropic/claude-sonnet-4-6"
  }
}
```

Key points:

- `model` must carry the provider prefix; a bare `modelId` fails immediately with `agent model must be provider/modelId format`
- Priority: explicit `model` > `tier` > session default model
- Tier names are yours to define (small/medium/big are just conventions); an unconfigured tier falls back to the session default with a warning log (non-fatal)
- Division of labor that works: throw cheap chores (classification/summary/format checks) at small models, keep the few critical generations on strong ones; when both use schema-constrained returns they don't interfere

## Schema Structured Returns

**Scenario**: your orchestration code consumes results by field (`if (result.ok)`, `result.files`) — don't let the model freestyle and then `JSON.parse` it yourself.

```javascript
const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'summary'],
}

const result = await agent('Analyze the risks of this module', { schema: SCHEMA })
if (!result.ok) return 'analysis failed: ' + (result.summary ?? '')
```

Key points:

- Return shape: with `schema` you get a JSON object (fields directly accessible); without it you get a string — mind the difference when mixing both styles in one script
- Put the fields your orchestration truly depends on in `required`; output is validated server-side, missing required fields count as failure and enter the same retry/failed flow as any agent
- Mechanism: uses OpenCode's native structured output (`format: json_schema`); if the gateway doesn't support it, it degrades automatically (JSON-instructed prompt + lenient local parsing + required-field validation) — scripts stay oblivious
- Known behavior: a schema agent's sub-session body may be empty (the result lives in the StructuredOutput tool call, not the body) — normal, not a bug; see [troubleshooting](troubleshooting.md)
- Combined with the quality DSL: when output format is flaky, `retry(() => agent(prompt, { schema }), { until: r => r && r.ok })`

## Timeouts & Retries (timeoutMs / retries)

**Scenario**: hard timeouts to cut losses on slow tasks; automatic retries for transient failures (network/rate-limit/timeout) so nobody babysits.

```javascript
// Per-agent: 60s hard timeout, 2 retries on recoverable failure (3 attempts total)
const r = await agent('Deep-analyze the docs directory and output a bullet-point summary', {
  label: 'docs-analysis',
  timeoutMs: 60000,
  retries: 2,
})
```

Run-wide defaults (tool args, applying to all agents of this run; per-agent values win):

```
Execute the following script with the workflow tool, exactly as-is, agentTimeoutMs=120000, agentRetries=1:

export const meta = { name: 'timeout_retry_demo', description: 'run-level timeout/retry defaults' }

const r = await Promise.all([
  agent('Task A: analyze README and summarize', { label: 'a' }),
  agent('Task B: analyze docs and summarize', { label: 'b', timeoutMs: 30000 }), // per-agent override to 30s
])
return r
```

Key points:

- `timeoutMs` in milliseconds; omit it (with no run-level default) for no hard timeout; the timeout error looks like `agent "x" timed out (ms)`
- `retries` capped at 3, default 0; timeouts count as retryable failures and consume retry budget
- Priority: per-agent `timeoutMs` / `retries` > tool args `agentTimeoutMs` / `agentRetries` > no timeout/no retry
- Distinction from the DSL `retry`: DSL retry means "repeat until the until-condition passes" (try differently when unsatisfied); `retries` means "retry as-is after recoverable failures" (network/rate-limit/timeout); they stack

## Parameterized Runs (args)

**Scenario**: rerun the same script across configurations (e.g. A/B model swaps) without touching a line; or inject external values (file lists, paths, timestamps) into the sandbox — the sandbox disables `Date.now()` / `Math.random()`, so dynamic values can only arrive via `args`.

The instruction (using examples/sample-project/scripts/node-detail-ab-test.js as the example, rerunning with a different model):

```
Execute scripts/node-detail-ab-test.js with the workflow tool, exactly as-is,
args = {"model": "biangfeng-gateway/glm-5.2"}
```

The receiving side (the script's actual code, with fallback defaults):

```javascript
// args.model is optional ("provider/modelId" form); default to the session model
const modelOptions = {}
if (args && typeof args.model === 'string') modelOptions.model = args.model

// Spread into agent options: present it applies, absent it falls back
const structured = await agent('...', { label: 'schema-reader', ...modelOptions, schema: SCHEMA })
```

Key points:

- `args` is a workflow tool arg (a JSON object) read via the global `args` in scripts, at any nesting depth
- Always type-check before consuming (`typeof args.xxx === 'string'`); parameters stay optional without errors
- Interaction with resume: changed args affect the prompts/models they control, changing those calls' hashes; resume replays only unaffected calls (rerun exactly what changed, as expected)
- Pure parameter changes without script edits can also ride `resumeFromRunId`: unchanged calls replay directly, only the parts the parameter touches rerun

## Background Long Tasks

**Scenario**: a big fan-out analysis (repo-wide audit, hundreds of files) runs for minutes while you keep chatting.

Say to the Main Agent:

```
Execute the following script in the background with the workflow tool (background: true), ... (script)
```

Behavior:

- The tool returns a runId immediately without blocking this turn; you can keep talking to the Main Agent normally while it runs
- On completion the result is **delivered back into the current session automatically as a message**, and the Main Agent picks it up
- Background runs survive Esc; manage them with the `workflow_control` tool:
  - `{ "action": "status" }` — list all background runs and progress (running first, with X/N agent stats)
  - `{ "action": "stop", "runId": "run-xxx" }` — stop a running run; completed parts stay in the journal
- Note: human checkpoints (`checkpoint`) inside background runs don't pop dialogs — they take the default value directly

## Resume from Breakpoint

**Scenario**: a 100-agent batch got interrupted at 80; you don't want to re-burn the first 80 agents' tokens.

Steps:

1. Note the runId from the previous output (in the header and metadata)
2. Edit the script (e.g. swap the synthesis prompt, append new agent calls)
3. Call the workflow tool again with `resumeFromRunId: "run-xxx"` and the modified script

Semantics (understand this, or results will surprise you):

- Calls match **by position**: the Nth `agent()` / `checkpoint()` call in the script compares against the Nth journal record
- Unchanged calls are **replayed** straight from the journal (no LLM, no tokens; the summary shows `[cached]`)
- The first changed call and **everything after it reruns**
- Therefore: when editing only the second half, keep the first half's call statements byte-identical and in order

## Quality DSL: verify / judgePanel / retry / checkpoint

Four helpers usable directly in scripts, typical usage:

```javascript
// verify: adversarial verification — several reviewers try to refute the claim;
// votes above threshold count as real
const verdict = await verify(agentResult, { reviewers: 3, threshold: 0.5 })
if (!verdict.real) return 'claim failed verification: ' + (verdict.reason ?? '')

// judgePanel: panel of judges — multiple judges score candidates against a
// rubric, highest average wins
const best = await judgePanel([planA, planB, planC], { judges: 3, rubric: 'correctness and cost' })

// retry: bounded retry — stops once the until-condition passes; on exhaustion
// returns the last result (never throws)
const out = await retry(() => agent('Generate config'), { attempts: 3, until: r => r && r.ok })

// checkpoint: human gate — pops a permission confirm; the decision is
// journaled and never re-asked on resume replay
if (!await checkpoint('About to modify production config files. Continue?')) return 'cancelled'
```

Choosing: conclusions others depend on → verify; picking one of several candidates → judgePanel; flaky output format → retry; before dangerous operations → checkpoint. Parameter details in the DSL reference.

## Composite Control Flow (sequence / fallback / race / check)

**When to use**: multi-level degradation, multi-way racing, structured nested control flow (like a "fix-then-reverify" chain). For plain serial work (A then B), keep using plain await chains — don't wrap everything in sequence mechanically.

```javascript
// Degradation chain: first successful candidate returns; if all recoverably
// fail you get null (same shape as an agent failure)
const r = await fallback([
  () => workflow('./fast.js'),
  () => workflow('./strong.js'),
])
if (!r) return 'all paths failed'

// Racing: first success wins, other candidates auto-cancelled (including
// their child workflows) — no wasted tokens
const best = await race([
  () => workflow('./model-a.js'),
  () => workflow('./model-b.js'),
])

// Deterministic gate: check asserts objective facts (false = recoverable
// failure, fallback switches candidates)
await sequence([
  () => agent('Generate config', { agentType: 'general' }),
  () => check(() => fileExists('config/out.json'), 'config file must exist'),
])
```

Semantic essentials:

- A node returning `null` / `false` / `{ok:false}` is still an **execution success** — write your own if for business vetoes; composite nodes won't judge for you
- A rejected `checkpoint()` throws `CHECKPOINT_REJECTED` as a hard stop: fallback won't switch candidates, parallel won't collapse it to null; resume replays the rejection deterministically (edit the prompt text to re-ask)
- Structural errors (typo'd script names, exceeded nesting) propagate directly — never disguised as degradation by fallback
- The TUI sidebar groups by `[Sequence]` / `[Race]`; checkpoints show "waiting for human / approved / rejected"

## Worktree Isolation (Parallel File-Writing Agents)

**Scenario**: several agents need to **modify files** at once; a shared directory means they overwrite each other.

```javascript
await parallel(tasks.map(task => () =>
  agent(`Refactor ${task.file} and describe the changes`, { agentType: 'general', isolation: 'worktree' })
))
```

Key points:

- Each agent runs in an independent git worktree (`.opencode-workflows/worktrees/<runId-...>`, branch `wf/<same-name>`), fully isolated
- Must pair with `agentType: 'general'` (default explore is read-only and can't write)
- In non-git directories or on worktree creation failure it **silently degrades** to the shared directory (visible in logs) — never aborts with an error
- Worktrees and branches are torn down automatically when the run ends (including timeout/interrupt); **changes are not auto-merged** — when you need them kept, have the agent write outputs to designated paths or return them as text

## Nested Workflows (Native workflow() Primitive — Recommended)

**Scenario**: compose multiple workflows into something bigger — multi-stage pipelines, parallel comparison of the same script under different configs, reusing existing stable sub-flows.

**Usage**: inside scripts, directly `await workflow(ref, args?)` — no LLM forwarding (the old general-agent forwarding scheme is legacy, see next section). One run shares concurrency quota and abort; parents can be pure orchestration (zero agents); results carry a "sub-flow duration" section (wall-clock, the right metric for config comparisons).

```javascript
export const meta = { name: 'full_pipeline', description: 'three-stage pipeline parent' }

phase('Orchestrate')
// Reference by path: previous stage's result feeds the next
const spec = await workflow('./scripts/1-spec.js')
const design = await workflow('./scripts/2-design.js', { brief: spec.brief })

// Reference by registry name: scripts under .opencode-workflows/workflows/
// addressed by meta.id ?? meta.name (slash names like 'ui/main-menu' are
// legal; same identity system as Schedule workflowIds)
const report = await workflow('daily-review', { design: design.design })

// Same script, multiple parallel instances: distinguished by label
// (UI/phase/journal identity)
const rs = await parallel([
  () => workflow({ scriptPath: './sub.js', label: 'deepseek' }, args),
  () => workflow({ scriptPath: './sub.js', label: 'gpt' }, args),
])
```

Constraints: one nesting level only; calling itself/ancestors is forbidden; args and return values must be structured-clone-compatible (objects/arrays/scalars; child edits don't leak out); sub-flow errors propagate (parents handle with try-catch).

## Nested Workflows (Legacy: general Sub-Agent Forwarding)

**Scenario**: chain multiple workflows into one big flow — an upper-level workflow's agent executes a complete sub-workflow itself (e.g. root → middle parallel fan-out → leaves), each level metering tokens, duration and journal independently.

**How it works**: `agent()` opens a normal sub-session; sub-agents with `agentType: 'general'` can call plugin tools (including `workflow`) just like the main session. **New scripts should use the native `workflow()` primitive above** (saves an LLM round, results pass through, single-run metering); this scheme remains for compatibility.

```javascript
export const meta = { name: 'chain_root', description: 'nested chain root: middle layer + leaves' }

phase('Launch')
// Delegate to a general sub-agent to execute the sub-workflow (scriptPath
// points at the child script file)
const middle = await agent(
  'Please invoke the workflow tool to execute a sub-workflow with these args:\n' +
  '- scriptPath: "scripts/chain-middle.js"\n' +
  'Do not pass background; do not pass script (either-or rule). Wait for the sub-workflow to actually finish.\n' +
  'Then output the final result JSON from the workflow tool verbatim as your reply, no explanatory text.',
  { label: 'sub-workflow:middle', agentType: 'general', timeoutMs: 600000 },
)

phase('Report')
return { middle }
```

Key points:

- **The prompt must spell out**: pass only `scriptPath`, no `background`/`script`, wait for completion, return the result JSON verbatim — otherwise the middle layer receives a paraphrase instead of structured data
- The child script is a completely normal workflow (it can nest another level); `args` travel via the upper prompt into the child call
- **TUI hierarchy tree**: a nested run's live/final subtree hangs directly under the triggering node (one indent level, thin arrows, independently collapsible), isomorphic between the sidebar and the fullscreen `/workflow` view; tokens aggregate per level, so layered costs are visible
- **Each level independent**: runId, journal, resume, snapshots don't interfere; resume each level with its own runId after interruption
- **No depth guard**: nesting has no hard limit — keep layers sane yourself (every level adds a general sub-agent session overhead)
- Nested sub-agent sessions share the main session's directory: snapshots attach to the main session by `rootSessionId` lineage; after a process restart the lineage is lost and those nested trees turn invisible (execution and results unaffected)

## Scheduled Tasks (Schedule)

Turn stable workflows into scheduled executions fired **deterministically** by the plugin's built-in scheduler (loads the script by workflowId directly, no LLM in the loop).

### Preparation: Put Workflow Scripts in the Conventional Directory

The project's `.opencode-workflows/workflows/`; scripts are plain workflows (`export const meta = { name: 'daily-review' }`, optional `meta.id` overrides name as the workflowId).

### Creation: Natural Language or Raw Cron

```
/schedule run daily-review.js hourly
```

Or have the Main Agent call the `schedule_create` tool. Four supported cron modes (`m`=minute `h`=hour `W`=weekday 0-6):

| Intent | cron |
| ------ | ---- |
| every n minutes | `*/n * * * *` |
| hourly at m | `m * * * *` |
| daily at h:m | `m h * * *` |
| weekly on W at h:m | `m h * * W` |

Creation output includes `Next run` and the boundary statement `Requires OpenCode running: Yes`.

### Management & Observability

- `schedule_list` / `schedule_get <id>`: next run, recent execution history
- `schedule_update` / `schedule_enable` / `schedule_disable` / `schedule_delete`: change cron/args/timeout, enable/disable, delete (never deletes the workflow file)
- `schedule_run_now <id>`: fire one verification round immediately (background; results in an independent session and the execution records)
- Execution records: `.opencode-workflows/runs/schedules/<scheduleId>/`, one JSON per round (status, duration, tokens, error); each round gets an independent OpenCode session, findable in the session list by time, agent tree included
- Overlap protection: while the previous round still runs, the new one is skipped (recorded as skipped); `timeoutMs` caps each round; during scheduled runs `checkpoint()` fails outright (unattended execution has no human channel)

### Boundaries (Know These)

Tasks don't execute while OpenCode is closed; missed slots never backfill (the next future slot fires normally); multiple OpenCode instances on the same project never double-fire.
