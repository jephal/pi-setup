# pi-setup

Jeppe's personal [pi](https://pi.dev) setup bundle.

This is the single installable Pi package for Jeppe's workflow. Feature boundaries remain modular inside the repository, but runtime users install one package: `@jephal/pi-setup`.

## Included features

- Fovea code graph
  - Agent-only cross-language code graph and token-budgeted repository navigation
  - Explicit sketch/focus/dwell/impact tools; no graph UI
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
  - Explicit save, search, update, and delete tools
  - Optional core-memory injection and bounded archival recall
- Native Pi subagent workflow
  - `scout`, `planner`, `reviewer`, `worker`, and `datadog-investigator` agents
  - Single, parallel, and chained isolated child sessions
  - `scout-and-plan`, `implement`, and `implement-and-review` prompts

## Install the complete setup

From npm (recommended):

```bash
pi install npm:@jephal/pi-setup
```

From GitHub while developing:

```bash
pi install git:github.com/jephal/pi-setup@main
```

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

## Development

All Pi features are shipped from this repository as one package. Source remains organized by feature: extension entrypoints live under `extensions/`, shared implementation lives under namespaced `src/` directories, and Fovea's skill lives under `skills/pi-fovea/`.

The original feature repositories remain available as historical sources, but new installs should use `@jephal/pi-setup`. The package manifest points directly at the consolidated local entrypoints and declares only true external dependencies; Pi's own runtime packages are peer dependencies supplied by the host.

Run the local test suite with:

```bash
npm test
```

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

The integration creates a right-side pane in the current tab with `herdr pane split --current --direction right --no-focus`, then runs the command in that pane. It does not create a new tab or workspace. `read_output` uses `herdr pane read --source recent-unwrapped`, so the model can inspect the same recent output that is visible in Herdr. Output is bounded; it does not wait for a development server to exit.

Use Pi's built-in `bash` tool for short-lived commands whose stdout/stderr the model needs in the current turn. Use `herdr_shell` for development servers, watchers, log processes, and other commands that should keep running visibly in Herdr. Reload Pi after updating the package:

```text
/reload
```

Herdr is optional. If Pi is not running inside Herdr, `herdr_shell` returns an explanatory error and normal `bash` remains available. Set `HERDR_BIN` if the Herdr executable is not on `PATH`. The minimum supported Herdr version is `0.7.5`.

Herdr panes are intentionally not closed when Pi reloads or exits. Ask the model to use `action: "close"`, or stop the process in Herdr, when the server should end.

For reproducible releases, replace `#main` references with version tags such as `#v0.1.0` after tagging the feature repositories.
