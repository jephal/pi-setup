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
- Visualization
  - Terminal-first Mermaid and deterministic Excalidraw previews
  - Pure ANSI/Unicode Excalidraw renderer and interactive terminal viewer
  - Official Excalidraw React viewer bundled as local static assets (preserved)
  - Tokenized loopback-only scene server with bounded, revision-checked writes
- Shared Pi UI primitives
  - Shared editable-option state and safe TUI rendering helpers
- Approval modes
  - Manual approval mode
  - Approve-code-edits mode
  - Auto mode
  - Review mode
  - Shared approval HITL UI
- Repository search
  - Gives Pi a native `repo_search` router for file-name and text searches
  - Auto routes glob-like queries to `find` and other queries to `grep`; explicit modes override
  - Uses Pi's native `find` and `grep` implementations for bounded repository search
- Native Pi 1.1 CodeMode and MCP
  - Uses the host's native CodeMode for bounded multi-tool orchestration instead of a custom CallScript layer
  - Uses Pi's native MCP support for configured servers, tool discovery, and permission handling
  - Keeps repository writes, shell/Herdr commands, Notes/Memory mutation, scheduled tasks, and subagents as direct tools with their existing approval policies
- Herdr shell integration
  - Gives Pi a `herdr_shell` tool for long-running commands and local servers
  - Gives visualization a dedicated `visualization-viewer` pane role; it never uses a generic shell or Notes pane
  - Creates one right-side pane in the current Herdr tab, never a new tab or workspace
  - Runs commands in the pane without blocking Pi
  - Reads bounded recent output back through Herdr's supported `pane read` API
  - Uses normal `bash` for short commands whose output Pi needs immediately
- Optional native Datadog MCP
  - Connects directly to Datadog's hosted OAuth-backed Streamable HTTP MCP server
  - Disabled by default; enable it with `PI_ENABLE_DATADOG_MCP=1`
  - Uses native deferred MCP exposure and `tool_search` rather than a local CLI or custom loader
  - Restricts the hosted endpoint to the read-only `core`, `error-tracking`, and `rum` toolsets
- Planning and Plan Board
  - Branch/session-scoped plan storage and a `plan` tool available in every approval mode
  - Saved plans use concise bullets for main points and numbered steps for tasks; users can request more detail or talk through questions before saving
  - Markdown task checkpoints and above-editor execution progress
  - Dedicated derived `plan-board` Herdr pane with explicit `plan_board` display actions
  - Bounded Markdown/checkpoint projection rendered with Pi's shared Markdown component, with safe plain-line fallback, Mermaid Unicode preprocessing, and optional Excalidraw ANSI scenes
  - Private 0600 socket snapshots with scrolling, redraw, revision checks, and safe recovery
  - Shared HITL decisions and feedback; Review mode remains read-only
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
install it separately if you want the notes viewer. Datadog access remains opt-in
and uses Pi's native hosted-MCP OAuth flow.

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

The setup registers Datadog's hosted Streamable HTTP MCP server through Pi's native
MCP support. Datadog is disabled by default, so sessions and child agents do not
connect to it unless explicitly enabled. Start Pi with the integration enabled:

```bash
PI_ENABLE_DATADOG_MCP=1 pi
```

Pi opens the native OAuth flow when the hosted server needs authentication. You can
also use `/mcp login datadog` explicitly. The default site is `us3`.

Pi then connects the native `datadog` MCP server with deferred exposure. Use Pi's
native `tool_search` to load only the Datadog capability needed for an investigation.
Unset `PI_ENABLE_DATADOG_MCP` or set it to `0` to keep Datadog disabled.

Optional site configuration:

```bash
export DD_MCP_SITE=us3       # us1, eu1, us3, us5, ap1, or ap2
```

The hosted endpoint is selected automatically for the site. Read-only behavior is
enforced by Datadog IAM permissions, the configured read-only toolsets, and native
MCP exposure filters. Grant only `mcp_read` and resource-read permissions, not
`mcp_write`.

## Repository search and native Pi orchestration

The package registers `repo_search`, a native repository search router. Glob-like queries route to file names and other queries route to file contents. Set `mode` to `files` or `text` to override auto routing. The compact schema accepts `query`, `mode`, `path`, `glob`, `ignoreCase`, `literal`, `context`, and `limit` as relevant to the selected search.

Pi 1.1 provides native CodeMode and MCP support. CodeMode is the preferred way to compose multiple registered tools without maintaining a second CallScript runtime. MCP servers are configured and governed by Pi's native MCP integration. The package keeps its direct tools independently registered so their existing approval, ownership, and lifecycle behavior remains authoritative.

Repository edits, shell and Herdr commands, Notes/Memory mutation, Datadog mutation, scheduled tasks, interactive visualization controls, and subagents remain direct-only. The package does not expose an unrestricted JavaScript runner or a generic nested write adapter.

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

## Local Excalidraw viewer

Persistent diagrams belong in Herdr, not in the Pi transcript. Use `action: "terminal_viewer"` with a bounded structured graph and `target: "open"`, `"update"`, `"status"`, or `"close"` after entering normal execution. The terminal viewer runs in a dedicated Herdr `visualization-viewer` pane when Pi runs inside Herdr, reuses that one pane across updates/reloads, and returns only a compact pane ID, revision, and status acknowledgement to Pi chat. The compatibility form `action: "viewer", target: "terminal_viewer"` remains accepted. Review mode permits previews and the existing browser viewer read-only, but blocks terminal pane control and artifact writes.

The terminal viewer runs in the current terminal outside Herdr. Controls are arrows or `h/j/k/l` to pan, `+/-` to zoom, `0` to reset, and `q` to quit. The process uses a private 0600 Unix-socket JSON protocol and an exact known viewer command (`node --experimental-strip-types <viewer-entry> --socket <socket>`); model-authored shell commands are never interpolated. `set_scene` is initial-only, later replacements use revision-checked updates, and each control connection accepts one frame only. Oversized, pipelined, or idle control connections are destroyed.

Use `action: "preview"` for Mermaid or Excalidraw previews; Mermaid and preview wireframes stay in Pi chat and are the default lightweight visualization. Use `action: "artifact"` only for an explicit project-relative `.excalidraw` file. Persistent Excalidraw visuals should use the Herdr pane so normal Pi output remains compact.

The terminal renderer supports rectangles, diamonds, ellipses, lines/arrows, and text, with bounded `LR`/`TD` graph layout and plain labels. It bounds terminal dimensions, scene elements, labels, output bytes, control buffers, and world coordinates; line drawing is bounded by the canvas. Unsupported Excalidraw elements are omitted from geometry and label calculations with an on-screen notice, and narrow panes report clipped labels. ANSI styling is applied after display-column clipping, including CJK, emoji, and combining text. Non-TTY invocations print one bounded ANSI/Unicode frame and remain controllable through the socket.

The existing browser viewer remains preserved and available, but is non-default: use `action: "viewer"`, `format: "excalidraw"`, and bounded structured `nodes`/`edges` when an external browser URL is explicitly needed. Pi starts a temporary HTTP server on `127.0.0.1` and returns a tokenized URL such as `http://127.0.0.1:<port>/viewer/?token=...`. Open that URL in a modern browser outside Herdr. The server exposes its current writable state to the browser; Review shows a clear read-only canvas and does not queue writes. Browser scene writes preserve unknown fields and merge embedded file records by ID. Browser assets under `viewer/` and `viewer/dist/` remain intact. Review mode may start this browser viewer, but its canvas is read-only and the `visualize` tool rejects terminal-pane and artifact requests.

The browser viewer is the official `@excalidraw/excalidraw` React application compiled into the package under `viewer/dist`. It uses only shipped local JavaScript, CSS, fonts, and other assets. The browser must support the bundled modern JavaScript and Excalidraw canvas APIs. Browser scene updates stay in memory, require the current revision, and are bounded; Pi closes the session server on reload or shutdown. Review mode permits the browser viewer only in read-only mode. Use `action: "artifact"` with an explicit project-relative `.excalidraw` path when a durable file is wanted.

The token is the access control for the local session. The server binds only to loopback, serves only the packaged viewer directory, does not execute scene values, and does not send scene data or scripts to a remote service. The token is used in the initial page URL only; the browser then uses the `HttpOnly` session cookie for API requests. The viewer also sends restrictive CSP and referrer policies. Anyone who can read the URL on the same user account can use that live session, so do not share it. The viewer is intentionally limited: it is not a collaboration server, does not persist browser edits by itself, and does not add Herdr embedding or remote access.

Rebuild the shipped browser bundle after changing viewer code with:

```bash
npm run build:viewer
```

The root `THIRD-PARTY-NOTICES` file contains the licenses for Excalidraw and the dependencies bundled into the viewer. Verify the release contents without creating an archive with:

```bash
npm run check:package
```

## Development

Stable Pi features are shipped from this repository as one package. Source remains organized by feature: extension entrypoints live under `extensions/`, and shared implementation lives under namespaced `src/` directories. Fovea remains a separately versioned bundled dependency so its graph engine can be updated independently.

The original feature repositories remain available as sources, but new installs should use `@jephal/pi-setup`. The package manifest points directly at the consolidated local entrypoints, bundles the current Fovea package separately, and declares Pi's runtime packages as peer dependencies supplied by the host.

Fovea requires no per-worktree initialization command. On the first graph request it creates a private SQLite cache under the user cache directory; subsequent clean-worktree focus, dwell, and impact calls use bounded SQLite reads. Stale worktree caches are reclaimed conservatively, with `/fovea cache status`, `/fovea cache dry-run`, and `/fovea cache purge` available for diagnostics. Obsidian/notes integrations remain separate from the code graph.

Run the local test suite with:

```bash
npm test
```

The package intentionally has no standalone TypeScript project configuration: Pi supplies the extension peer dependencies and loads TypeScript directly. The supported runtime is Node 22.6.0 or newer because the viewer launch command uses `--experimental-strip-types`. The test suite runs the extension test files with Node's TypeScript stripping, and focused `node --experimental-strip-types --check` commands are used for edited entrypoints instead of adding a loader-specific typecheck configuration.

## Subagents

The setup includes Pi's first-party subagent workflow with bundled defaults. The
`datadog-investigator` agent is available only when `PI_ENABLE_DATADOG_MCP=1` and
uses Pi's native `tool_search` plus the `mcp__datadog__...` tool namespace. Child Pi
processes inherit the opt-in environment and native MCP configuration; no custom
OAuth session or forwarding bridge is created.

Subagents use role-aware model tiers. Bundled agents default to the medium
route for ordinary work; the main model can override a single call, parallel
item, or chain step with `modelTier` when the task warrants it.

```text
fast     → role-specific; gpt-5.6-luna for unconfigured roles
medium   → role-specific; gpt-6-sol for unconfigured roles
complex  → role-specific; gpt-5.6-sol for unconfigured roles
```

Tier routes use these model IDs logically rather than requiring the documented
provider. When the active catalog exposes a target ID through the parent
provider, subagents use that provider; otherwise they use another available
provider for the ID. If the target is unavailable, they retain the active parent
model. When both `modelTier` and `model` are present, `modelTier` takes
precedence. An explicit agent `model:` is used when no tier is set. Thinking
levels are configured separately from model tiers: children inherit the parent's
level unless an agent specifies `thinkingLevel:`.

Default tiers and per-tier model/thinking routes:

| Agent | Default tier | Fast | Medium | Complex |
| --- | --- | --- | --- | --- |
| Scout | Fast | GPT-6 Luna / medium | GPT-6 Luna / high | GPT-6 Luna / xhigh |
| Planner | Medium | GPT-6 Luna / high | Claude Opus 5.5 / low | Claude Opus 5.5 / medium |
| Reviewer | Medium | GPT-6 Luna / high | Claude Opus 5.5 / low | Claude Opus 5.5 / medium |
| Worker | Medium | GPT-6 Luna / high | GPT-6 Sol / medium | Claude Opus 5.5 / medium |
| Datadog investigator | Fast | GPT-6 Luna / medium | GPT-6 Luna / high | GPT-6 Luna / xhigh |

Each cell shows `model / thinking level`. The main Pi model remains GPT-6 Luna at
high thinking. Custom agents without role-specific routes continue to use the
fallback tier models above and inherit the parent thinking level unless they
set `thinkingLevel:`.

Choose `fast` for reconnaissance, simple searches, short summaries, and clear
low-risk tasks. Choose `medium` by default for ordinary planning, review, tests,
bug fixes, and bounded implementation. Treat `complex` as a rare exception, not
a default: use it only for genuinely ambiguous architecture, security or
concurrency risk, difficult debugging, high-cost failure, or a failed medium
attempt. When unsure, choose medium. Do not choose complex merely because a task
is long, multi-file, or important; upgrade only the affected step.

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

The background limit is **eight active child executions**, not eight historical task records. Completed children are closed, their supervisor/MCP bridges are released, and only bounded terminal snapshots remain. Retained terminal tasks and batches have count and time limits, so they cannot grow indefinitely.

A `followUp` sent to a running child preserves its live RPC context. A `followUp` sent after completion starts a fresh child with the same public task ID and a bounded replay prompt containing the original task, bounded prior output/diagnostics, and the new request. This avoids keeping completed child processes alive. `steer` is available only while the child is active.

`get_subagent_result` and `get_subagent_batch_result` return detailed output once and then retain only compact continuation state. Repeated reads return the compact snapshot. Follow-ups are available only while that compact snapshot remains retained.

Use `get_subagent_status` only for an intentional one-time inspection, and `get_subagent_result` for one task. Set `background: false` when the parent needs an inline result. Chains remain synchronous because each step depends on the previous result.

Background tasks are scoped to the current Pi session and are stopped on reload, session replacement, or shutdown. Their intermediate output stays outside the parent context until the batch result is requested. A child can use the child-only `contact_supervisor` tool for an important progress update or decision request. The parent can answer by sending a follow-up message with the task ID.

Background workers share the selected working directory, so do not run concurrent write-capable agents against the same files unless you have an explicit coordination strategy. Give each worker disjoint file ownership or use a worktree. Direct child-to-child team messaging is intentionally not part of this workflow.

### Temporary storage on shared VMs

The package registers `extensions/temp-storage.ts` before the other extensions. At
session start it routes future Node temp files to a private directory:

```text
$XDG_RUNTIME_DIR/pi-setup
```

If `XDG_RUNTIME_DIR` is unavailable, it falls back to
`~/.cache/pi-setup/tmp`. The directory is created with mode `0700`; no existing
files are deleted or moved. Set `PI_SETUP_TEMP_DIR` to choose another absolute
private directory, or set `PI_SETUP_DISABLE_PRIVATE_TEMP=1` to opt out.

This isolates future `pi-bash-*`, Fovea, subagent, and MCP bridge artifacts from
other users on a shared VM. The `pi_temp_storage_report` tool provides a
read-only inventory of known artifacts, sessions, and Fovea cache; it never
changes files. The upstream Pi bash output files still require a separate
age/size janitor. Existing `/tmp` artifacts are intentionally left untouched
until a separately confirmed cleanup.

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

The integration creates a right-side pane in the current tab with `herdr pane split --pane <caller> --direction right --no-focus` (falling back to `--current` when needed), then runs the command in that pane. It does not create a new tab or workspace. Each binding is scoped to the current Herdr worktree, tab, working directory, and owning Pi agent pane, so agents in the same worktree never share a managed shell. Every operation resolves the live caller context, validates the saved pane and terminal identity from Herdr pane records, and sends a command only when the pane shell owns the foreground. A changed generic-shell terminal ID is treated as lost ownership: the restored pane is left untouched and a later open/run creates a fresh managed pane. A pane that was closed is forgotten; a pane that was moved or is busy with an editor/process is left untouched and reported as unavailable rather than risking input to the wrong process. `read_output` uses `herdr pane read --source recent-unwrapped`, so the model can inspect the same recent output that is visible in Herdr. Output is bounded; it does not wait for a development server to exit.

Use Pi's built-in `bash` tool for short-lived commands whose stdout/stderr the model needs in the current turn. Use `herdr_shell` for development servers, watchers, log processes, and other commands that should keep running visibly in Herdr. Reload Pi after updating the package:

```text
/reload
```

Herdr is optional. If Pi is not running inside Herdr, `herdr_shell` returns an explanatory error and normal `bash` remains available. Set `HERDR_BIN` if the Herdr executable is not on `PATH`. The minimum supported Herdr version is `0.7.5`.

Generic Herdr shell panes are intentionally not closed when Pi reloads or exits. Plan Board panes use the dedicated `plan-board` role and a private socket. The board is a derived display of Pi's authoritative plan, scoped to the current session/workspace/tab/owner, and is opened explicitly with `plan_board({ action: "open" })`; plan saves, checkpoint transitions, execution approval, clears, reloads, branch changes, and explicit board-scene previews update or clear an already active board without opening a second diagram pane. Board snapshots enforce an aggregate size limit across Markdown, fallback lines, and optional scenes; a scene is carried only across non-cleared updates in the same plan scope, so clears and scope changes remove stale diagrams. Use `plan_board` with `update`, `status`, or `close` for fixed lifecycle operations. It never accepts arbitrary commands and never reuses Notes, generic-shell, visualization, or human panes.

Visualization terminal panes use the separate `visualization-viewer` role and remain available for independent diagrams. If a Plan Board or viewer pane becomes stale, its process identity changes, its owner is lost, or the user presses `q`, the integration verifies the dedicated process before closing/recovering it; otherwise it leaves the live pane untouched and retires only its binding. Existing browser and terminal viewer files remain preserved.

For reproducible releases, replace `#main` references with version tags such as `#v0.1.0` after tagging the feature repositories.
