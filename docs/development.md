# Contributor Guide

[**English**](./development.md) | [简体中文](./zh-CN/development.md)

> User documentation lives in pages like [getting-started](getting-started.md); this page is for contributors changing the code. The single source of truth for AI coding rules is [AGENTS.md](../AGENTS.md) at the repo root — this page is only a human-oriented summary and how-to.

## Environment & Common Commands

```bash
npm install
npm run build       # produces dist/ (server side)
npm run typecheck   # tsc --noEmit (three tsconfigs: server + test + tui)
npm test            # node:test + tsx, 106 cases (3~4 seconds, no real LLM calls)
```

- Node.js 18+ required; the CI release pipeline runs typecheck + test on Node 22 before publishing
- The TUI side has no build output: OpenCode's built-in runtime reads `src/tui` source directly

## Architecture at a Glance

```
src/
├─ index.ts        # plugin entry (thin): registers the workflow / workflow_control tools
├─ runtime/        # workflow execution core: VM sandbox, concurrency semaphore, error
│                  # classification — host-agnostic
├─ agent/          # AgentSessionRunner interface + model tiers
├─ adapters/       # the only place OpenCode SDK may appear (OpenCodeSessionAdapter)
├─ tools/          # tool implementations: workflow, workflow_control, result rendering,
│                  # run snapshots, background runs
├─ tui/            # TUI-side plugin (sidebar live tree)
├─ cli/            # npx installer: install / update / uninstall / doctor
├─ persistence/    # journal (resume data)
└─ isolation/      # git worktree isolation
```

Key constraints (details in AGENTS.md):

- `src/runtime/` must not import the OpenCode SDK — the runtime stays host-agnostic; the correct chain is `runtime → AgentSessionRunner interface → OpenCodeSessionAdapter → client.session.*`
- `src/index.ts` only initializes dependencies and registers; no business logic
- Child sessions are always created through the adapter
- TUI-side solid-js usage is only allowed in the single file `src/tui/plugin.tsx` (multiple files resolve different solid-js instances and signals die); pure data logic goes into separate ts files
- Comments and logs in Chinese, no emoji, files UTF-8

## Tests

- Framework: node:test + tsx; runtime tests inject fake runners (countingAgent / deferredAgent / deferred-gate patterns), no HTTP mocking
- Worktree-related tests run real git
- New scripts/logic get a matching `xxx.test.ts` per project convention; the test injection seam is the `AgentSessionRunner` interface

## Local Development Loop

`examples/sample-project/` is a self-contained manual acceptance workspace:

```
cd examples/sample-project
opencode
```

- Its `opencode.json` / `tui.json` reference the repo root via the relative path `"../.."`, auto-loading this repo's plugin and skills
- `plugin` resolves relative to the config file's directory; `skills.paths` resolves relative to OpenCode's startup directory — starting from this directory the two coincide, no absolute paths needed
- After changing server-side code, run `npm run build` then restart OpenCode; TUI-side changes just need a restart
- Acceptance scripts live in `examples/sample-project/scripts/`; see [docs/testing.md](testing.md) and the in-directory test guides

## Release

Pushing a `v*` tag triggers automatic npm publishing via CI (`.github/workflows/publish.yml`):

```bash
npm version patch        # bump version + commit + tag (e.g. v0.2.2)
git push --follow-tags   # tag push triggers the pipeline: typecheck + test, then npm publish
```

The pipeline validates that the tag matches the package.json version, preventing wrong-version releases.

## Documentation Maintenance

- User docs live in this directory (`docs/`); README keeps only positioning, install, quick start, and the doc map
- The authoritative DSL API description is `skills/workflow-authoring/references/runtime.md` (distributed with the npm package to the Main Agent); user docs link to it rather than copying — avoid dual-source drift
- Commands and outputs in docs must be actually run before being written down; avoid hard-coding third-party version numbers
