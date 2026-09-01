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

From GitHub (recommended):

```bash
pi install git:github.com/jephal/pi-setup@docs/github-only-install
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

The extension is intended for read-only investigation. Give the Datadog account
`mcp_read` and resource read permissions, but not `mcp_write`.

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

When Pi runs inside Herdr, use `/notes-open` or ask the agent to use `notes_open_viewer`. Neovim is launched in the managed right-side pane used by `herdr_shell`; if Herdr is unavailable, the command is returned for a normal VM terminal instead. Pi can open validated notes, refresh changed buffers, and explicitly save through a private local Neovim socket. It cannot execute arbitrary Neovim commands.

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

```text
scout              → gpt-5.6-luna
planner            → claude-opus-5
reviewer           → claude-opus-5
worker             → gpt-5.6-terra
datadog-investigator → gpt-5.6-luna
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

The setup installs missing default agent definitions into `~/.pi/agent/agents/` without overwriting existing files. Project-local agents remain opt-in and require confirmation.

### Herdr shell integration

When Pi runs inside Herdr (`HERDR_ENV=1`), the `herdr_shell` tool lets the model place long-lived processes in a right-side pane while keeping the Pi pane visible:

```text
herdr_shell({ action: "open", command: "pnpm dev" })
herdr_shell({ action: "read_output", lines: 80 })
herdr_shell({ action: "status" })
herdr_shell({ action: "close" })
```

The integration creates a right-side pane in the current tab with `herdr pane split --pane <caller> --direction right --no-focus` (falling back to `--current` when needed), then runs the command in that pane. It does not create a new tab or workspace. If the managed pane was closed or disappears while a command is being sent, `open` and `run` automatically create a replacement pane and retry once. `read_output` uses `herdr pane read --source recent-unwrapped`, so the model can inspect the same recent output that is visible in Herdr. Output is bounded; it does not wait for a development server to exit.

Use Pi's built-in `bash` tool for short-lived commands whose stdout/stderr the model needs in the current turn. Use `herdr_shell` for development servers, watchers, log processes, and other commands that should keep running visibly in Herdr. Reload Pi after updating the package:

```text
/reload
```

Herdr is optional. If Pi is not running inside Herdr, `herdr_shell` returns an explanatory error and normal `bash` remains available. Set `HERDR_BIN` if the Herdr executable is not on `PATH`. The minimum supported Herdr version is `0.7.5`.

Herdr panes are intentionally not closed when Pi reloads or exits. Ask the model to use `action: "close"`, or stop the process in Herdr, when the server should end.

For reproducible releases, replace `#main` references with version tags such as `#v0.1.0` after tagging the feature repositories.
