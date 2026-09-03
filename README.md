# pi-setup

Jeppe's personal [pi](https://pi.dev) setup bundle.

This is the single GitHub-installable Pi package for Jeppe's workflow. Feature boundaries remain modular inside the repository, but runtime users install one package: `@jephal/pi-setup`.

## Included features

- Fovea code graph (bundled dependency)
  - Agent-only cross-language code graph and token-budgeted repository navigation
  - Private per-worktree SQLite snapshots with automatic first-use initialization
  - Clean-worktree `focus`, `dwell`, and `impact` queries load bounded graph neighborhoods
  - First bootstrap, `sketch`, and relevant dirty-worktree changes use a fresh full graph
  - Safe defaults: no proactive turn sync, no grep interception, no credential-file indexing
  - Uses `ast-grep` for extraction; install it once with `npm install --global @ast-grep/cli@0.45.2`
- Ask Questions
  - Keyboard-driven questionnaires
  - Inline option editing
  - Free-form answers
  - Optional ASCII visualizations
- Shared Pi UI primitives
  - Shared editable-option state and safe TUI rendering helpers
- Approval modes
  - Manual approval mode
  - Approve-code-edits mode
  - Auto mode
  - Review mode
  - Shared approval HITL UI
- Herdr shell integration
  - Gives Pi a `herdr_shell` tool for long-running commands and local servers
  - Creates one right-side pane in the current Herdr tab, never a new tab or workspace
  - Runs commands in the pane without blocking Pi
  - Reads bounded recent output back through Herdr's supported `pane read` API
  - Uses normal `bash` for short commands whose output Pi needs immediately
- Datadog MCP
  - Connects pi to Datadog through the official OAuth-backed local MCP CLI
  - Keeps only a small `datadog_search_tools` loader active in pi's context
  - Loads matching `core`, `error-tracking`, and `rum` tools on demand
  - Keeps Datadog credentials in the CLI's local OAuth store, not in this repository
- Plan mode
  - Branch/session-scoped plan storage
  - Concise plan review UI
  - Shared HITL decisions and feedback
  - Markdown task checkpoints and above-editor execution progress
  - Visible Plan → execution transitions
  - Full Markdown plans in Plan mode; compact checklist-only tracking outside Plan mode
  - Plan mode keeps non-code-changing tools available, including notes, memory, Fovea, Herdr inspection, Datadog investigation, and scheduled tasks
  - Project code mutation tools and unsafe shell commands remain blocked in Plan mode
  - Research first: Plan mode is for the final decision and execution contract, not initial research; scope and conclusion first, key decisions, rationale, trade-offs, risks, and next decision
- Memory
  - Local SQLite-backed user and project memories
  - Main-agent-driven capture of stable patterns noticed during normal work
  - One `memory` tool for search, save, update, list, and delete actions
  - Importance-weighted freshness and duplicate consolidation
  - Core-memory injection and bounded automatic recall with stale filtering
  - `/memory-capture`, `/memory-recall`, and `/memory-stale` controls for recall and guidance
- Local notes integration
  - Agent-first filesystem tools for listing, searching, reading, writing, copying, and moving Markdown notes
  - Path-only copy/move operations keep unchanged note content out of the model context
  - Directory-scoped path protection with hidden metadata directories excluded from discovery
  - No desktop application, HTTP server, or API key required
- Agent-first scheduled tasks
  - The agent creates, lists, cancels, and runs recurring or one-shot prompts when asked
  - Local SQLite persistence scoped by Pi session and working directory
  - IANA timezone-aware five-field cron, coalesced missed fires, and busy-turn follow-ups
- Native Pi subagent workflow
  - `scout`, `planner`, `reviewer`, `worker`, and `datadog-investigator` agents
  - Single, parallel, and chained isolated child sessions
  - `scout-and-plan`, `implement`, and `implement-and-review` prompts

## Install the complete setup

### One-command Linux bootstrap

This installs Pi through Pi's official installer, installs this package, installs
Herdr through Herdr's official installer, installs the Fovea `ast-grep` dependency,
creates `~/notes`, and writes a user-local environment file. It does not use `sudo`
or modify shell startup files:

```bash
curl -fsSL https://raw.githubusercontent.com/jephal/pi-setup/main/install.sh | bash
source ~/.config/pi-setup/env
pi
```

The installer is safe to rerun. It preserves an existing
`~/.config/pi-setup/env` file rather than overwriting it. Neovim remains optional;
install it separately if you want the notes viewer. Datadog OAuth authentication
also remains an explicit user step below.

### Install the Pi package only

If Pi and the local dependencies are already installed:

```bash
pi install git:github.com/jephal/pi-setup@main
```

An npm package name is reserved for a future release, but npm publication is not required for this setup.

Then reload Pi:

```text
/reload
```

## Datadog MCP (OAuth)

The setup includes a personal pi extension that bridges Datadog's official local MCP
CLI into pi. Datadog-aware subagents can forward their tool searches and calls to the
parent pi process, so the OAuth-backed MCP client stays in the parent and is not
recreated in every child process. Install the CLI once and authenticate with Datadog:

```bash
curl -sSL https://coterm.datadoghq.com/mcp-cli/install.sh | bash
~/.local/bin/datadog_mcp_cli --site us3 login
```

The login command opens the Datadog OAuth flow in a browser. After completing it,
restart pi or run `/datadog-connect`. The extension uses the US3 endpoint and makes
`core`, `error-tracking`, and `rum` tools searchable on demand. Only the small
`datadog_search_tools` loader is active initially, so Datadog tool definitions do not
bloat every session. Run `/datadog-reset` after an investigation to unload any
Datadog tools activated during the session.

Optional environment variables:

```bash
export DD_MCP_CLI="$HOME/.local/bin/datadog_mcp_cli"
export DD_MCP_SITE=us3
export DD_MCP_ENDPOINT_PATH='v1/mcp?toolsets=core,error-tracking,rum'
```

Read-only behavior is enforced by two authoritative boundaries: the Datadog IAM
permissions on the account and the explicitly configured MCP endpoint toolsets. Grant
only `mcp_read` and resource-read permissions (not `mcp_write`), and keep
`DD_MCP_ENDPOINT_PATH` limited to the configured `core`, `error-tracking`, and `rum`
toolsets. The extension does not infer permissions from tool names or apply a `write`
name heuristic; unexpected endpoint toolsets are rejected.

## Local notes integration

The integration is deliberately filesystem-based: notes are Markdown files, so Pi can work with a local notes directory without a desktop application, plugin, or REST API. Configure the directory before starting Pi:

```bash
export NOTES_PATH="$HOME/notes"
```

The package registers these agent tools:

- `notes_list` — discover Markdown notes, optionally under a folder.
- `notes_search` — bounded grep-like search for note content or filenames, with literal/regex, glob, case, context, and path-only options.
- `notes_read` — read one Markdown note.
- `notes_write` — explicitly create, overwrite, or append to a note.
- `notes_transfer` — copy or move a Markdown note by path without reading or rewriting its content; destination files are never overwritten.
- `notes_open_viewer` — open Neovim with the notes directory in a Herdr side pane when available.
- `notes_open_note` — open a validated note in the running Neovim instance.
- `notes_refresh` — ask Neovim to detect files changed by Pi or another process.
- `notes_save` — explicitly save the current Neovim buffer.
- `notes_git` — explicitly run local Git status, diff, or commit against the notes repository.

`notes_search` is the preferred discovery interface instead of raw shell commands: it keeps searches inside the configured vault and returns bounded structured matches. Literal, case-insensitive search of content and filenames is the default. Use `mode: "regex"` for content patterns, `mode: "filename"` for path-only discovery, `glob` (relative to the selected `path`) and `path` to narrow scope, `contextLines` for a small surrounding window, and `pathsOnly: true` for minimal-token results. Regex searches run in an isolated worker with bounded per-line input and a timeout. Use `notes_read` only after locating the notes that need full context.

The visual interface is Neovim with a small checked-in configuration at `src/notes/nvim-init.lua`. It uses Neovim’s built-in folder explorer and syntax highlighting, has no plugins, and exposes a `:NotesHelp` command plus discoverable shortcuts. Start it directly in the VM with:

```bash
nvim --clean -u src/notes/nvim-init.lua "$NOTES_PATH"
```

When Pi runs inside Herdr, use `/notes-open` or ask the agent to use `notes_open_viewer`. Neovim has its own managed Notes-viewer pane and is never reused by `herdr_shell`; the singleton viewer is found through its private local socket even when it is in another Herdr workspace or tab. Its launch lock is owner-token guarded, and stale sockets are removed only after a direct local connection is refused; a slow Neovim RPC never removes a live socket. Socket paths include the local UID and cleanup refuses sockets owned by another UID. As with other same-user Unix sockets, this assumes the local user account is trusted. If Herdr is unavailable, the command is returned for a normal VM terminal instead. Pi can open validated notes, safely check changed buffers without replacing dirty human edits, and explicitly save through a private local Neovim socket. It cannot execute arbitrary Neovim commands.

All note paths are relative to the configured notes directory, which is a separate NOTES_PATH vault and not the current project directory. For listing and searching, omit `path` or use `.` to address the vault root; blank directory values are handled the same way. Traversal is rejected, writes and transfers cannot leave the directory, hidden directories are excluded from discovery, and note reads/writes/transfers are bounded to 5 MiB. Use `notes_transfer` with `action: "move"` or `action: "copy"` when relocating or duplicating an existing note: only the source and destination paths cross the model boundary, so unchanged content does not consume context tokens. Destination files are refused rather than overwritten. Transfers preserve note bytes exactly, including any filename-derived frontmatter title; if a rename should also change metadata, use `notes_read` and `notes_write` afterward. Tool output is bounded to keep large directories from overwhelming the model context. Use `/notes` to show the resolved notes directory in interactive Pi. Git operations are explicit and local-only; no remote is configured.

Every note uses a small YAML frontmatter header so agents and tools can reference it consistently:

```yaml
---
title: Human-readable note title
type: note
status: active
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---
```

New or updated notes receive missing defaults automatically; existing metadata is preserved and `updated` is refreshed. The implementation supports a conservative YAML subset and does not add a YAML package. The integration is agent-first and does not automatically inject the whole directory into context. Ask the agent to search or list notes when needed, then read only the relevant notes. For writes, the agent must choose `create`, `overwrite`, or `append` explicitly.

## Development

Stable Pi features are shipped from this repository as one package. Source remains organized by feature: extension entrypoints live under `extensions/`, and shared implementation lives under namespaced `src/` directories. Fovea remains a separately versioned bundled dependency so its graph engine can be updated independently.

The original feature repositories remain available as sources, but new installs should use `@jephal/pi-setup`. The package manifest points directly at the consolidated local entrypoints, bundles the current Fovea package separately, and declares Pi's runtime packages as peer dependencies supplied by the host.

Fovea requires no per-worktree initialization command. On the first graph request it creates a private SQLite cache under the user cache directory; subsequent clean-worktree focus, dwell, and impact calls use bounded SQLite reads. Stale worktree caches are reclaimed conservatively, with `/fovea cache status`, `/fovea cache dry-run`, and `/fovea cache purge` available for diagnostics. Obsidian/notes integrations remain separate from the code graph.

Run the local test suite with:

```bash
npm test
```

The package intentionally has no standalone TypeScript project configuration: Pi supplies the extension peer dependencies and loads TypeScript directly. The test suite runs the extension test files with Node's TypeScript stripping, and focused `node --experimental-strip-types --check` commands are used for edited entrypoints instead of adding a loader-specific typecheck configuration.

## Subagents

The setup includes Pi's first-party subagent workflow with bundled defaults. The
`datadog-investigator` agent uses the lazy Datadog loader; when it runs as a child,
Datadog tool metadata and calls are forwarded through a private per-child bridge to
the parent process.

The forwarding bridge is fail-closed, scoped to the Datadog tools exposed by the
parent's configured MCP endpoint, and does not pass OAuth credentials to child
processes.

```text
parent pi ── private Unix socket ──> child datadog tools
    └── Datadog MCP client / OAuth CLI
```

Subagents use role-aware model tiers. Bundled agents default to the medium
route for ordinary work; the main model can override a single call, parallel
item, or chain step with `modelTier` when the task warrants it.

```text
fast     → gpt-5.6-luna
medium   → claude-sonnet-5 for planning/review, gpt-5.6-terra for implementation
complex  → claude-opus-5 for planning/review, gpt-5.6-sol for implementation
```

Default presets:

```text
scout                 → fast / gpt-5.6-luna
planner               → medium / claude-sonnet-5
reviewer              → medium / claude-sonnet-5
worker                → medium / gpt-5.6-terra
datadog-investigator  → fast / gpt-5.6-luna
```

Choose `fast` for reconnaissance, simple searches, short summaries, and clear
low-risk tasks. Choose `medium` by default for ordinary planning, review, tests,
bug fixes, and bounded implementation. Choose `complex` only for ambiguous
architecture, security or concurrency risk, difficult debugging, high-cost
failure, or a failed medium attempt. When unsure, choose medium; task length
alone is not a reason to choose complex.

For example, a normal mixed chain can keep the scout fast while escalating only
the risky implementation step:

```text
subagent({ chain: [
  { agent: "scout", task: "Find the relevant code", modelTier: "fast" },
  { agent: "planner", task: "Plan the change using {previous}" },
  { agent: "worker", task: "Implement the plan using {previous}", modelTier: "complex" }
] })
```

Use the read-only workflow first:

```text
/scout-and-plan <task>
```

Implementation workflows are also available:

```text
/implement <task>
/implement-and-review <task>
```

The setup installs missing default agent definitions into `~/.pi/agent/agents/` without overwriting existing files. Project-local agents remain opt-in and require confirmation. Existing custom agents may keep an exact `model:` value; agents without `modelTier` retain that legacy model. Because installed defaults are never overwritten, remove or update an existing copied agent definition if you want the new bundled tier preset to take effect.

### Background subagents

The `subagent` tool keeps its existing synchronous behavior by default. Single-agent tasks run in the background by default and return immediately with a task ID. For independent work, set `background: true` with a `tasks` array to launch a background batch:

```text
subagent({ tasks: [
  { agent: "scout", task: "Inspect the authentication flow" },
  { agent: "scout", task: "Inspect the authentication tests" },
  { agent: "reviewer", task: "Identify security risks in the authentication flow" }
], background: true })
```

The call returns a batch ID immediately. Completion is event-driven: Pi sends one compact completion message when all tasks settle. Do not poll status or sleep in a loop. Retrieve all worker outputs once after that message:

```text
get_subagent_batch_result({ batchId: "abcd1234" })
send_subagent_message({ taskId: "task5678", message: "Also check the migration scripts", delivery: "followUp" })
cancel_subagent_batch({ batchId: "abcd1234" })
```

Use `get_subagent_status` only for an intentional one-time inspection, and `get_subagent_result` for one task. Set `background: false` when the parent needs an inline result. Chains remain synchronous because each step depends on the previous result.

Background tasks are scoped to the current Pi session and are stopped on reload, session replacement, or shutdown. Their intermediate output stays outside the parent context until the batch result is requested. A child can use the child-only `contact_supervisor` tool for an important progress update or decision request. The parent can answer by sending a follow-up message with the task ID.

Background workers share the selected working directory, so do not run concurrent write-capable agents against the same files unless you have an explicit coordination strategy. Give each worker disjoint file ownership or use a worktree. Direct child-to-child team messaging is intentionally not part of this workflow.

### Herdr agent state integration

For accurate Herdr sidebar state, install Herdr's managed Pi integration once:

```bash
herdr integration install pi
```

Then reload Pi with `/reload`. The integration reports normal Pi lifecycle state as `working` or `idle`, and this package reports its human-in-the-loop dialogs as `blocked`: `ask_questions`, Plan review and editing, approval prompts, memory deletion confirmation, and project-agent approval. Herdr uses `blocked` for needs-attention indicators, waits, notifications, and workspace/tab rollups. Herdr owns the installed file at `~/.pi/agent/extensions/herdr-agent-state.ts`; do not copy or edit that file in this repository. The event reports are harmless when the integration is not installed or Pi is running outside Herdr.

### Herdr shell integration

When Pi runs inside Herdr (`HERDR_ENV=1`), the `herdr_shell` tool lets the model place long-lived processes in a right-side pane while keeping the Pi pane visible:

```text
herdr_shell({ action: "open", command: "pnpm dev" })
herdr_shell({ action: "read_output", lines: 80 })
herdr_shell({ action: "status" })
herdr_shell({ action: "close" })
```

The integration creates a right-side pane in the current tab with `herdr pane split --pane <caller> --direction right --no-focus` (falling back to `--current` when needed), then runs the command in that pane. It does not create a new tab or workspace. Every operation resolves the live caller context, validates the saved pane and terminal identity from Herdr pane records, and sends a command only when the pane shell owns the foreground. A changed generic-shell terminal ID is treated as lost ownership: the restored pane is left untouched and a later open/run creates a fresh managed pane. A pane that was closed is forgotten; a pane that was moved or is busy with an editor/process is left untouched and reported as unavailable rather than risking input to the wrong process. `read_output` uses `herdr pane read --source recent-unwrapped`, so the model can inspect the same recent output that is visible in Herdr. Output is bounded; it does not wait for a development server to exit.

Use Pi's built-in `bash` tool for short-lived commands whose stdout/stderr the model needs in the current turn. Use `herdr_shell` for development servers, watchers, log processes, and other commands that should keep running visibly in Herdr. Reload Pi after updating the package:

```text
/reload
```

Herdr is optional. If Pi is not running inside Herdr, `herdr_shell` returns an explanatory error and normal `bash` remains available. Set `HERDR_BIN` if the Herdr executable is not on `PATH`. The minimum supported Herdr version is `0.7.5`.

Herdr panes are intentionally not closed when Pi reloads or exits. Ask the model to use `action: "close"`, or stop the process in Herdr, when the server should end.

For reproducible releases, replace `#main` references with version tags such as `#v0.1.0` after tagging the feature repositories.
