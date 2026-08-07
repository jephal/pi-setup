# pi-setup

Jeppe's personal [pi](https://pi.dev) setup bundle.

This is a parent/meta-package: it combines independently maintained Pi feature packages and shared UI primitives into one installable setup.

## Included features

- [`pi-ask-questions`](https://github.com/jephal/pi-ask-questions)
  - Keyboard-driven questionnaires
  - Inline option editing
  - Free-form answers
  - Optional ASCII visualizations
- [`pi-ui`](../pi-ui)
  - Shared editable-option state and safe TUI rendering helpers
- [`pi-approval-modes`](https://github.com/jephal/pi-approval-modes)
  - Manual approval mode
  - Approve-code-edits mode
  - Auto mode
  - Review mode
  - Shared approval HITL UI
- [`pi-plan-mode`](../pi-plan-mode)
  - Branch/session-scoped plan storage
  - Concise plan review UI
  - Shared HITL decisions and feedback
  - Markdown task checkpoints and above-editor execution progress
  - Visible Plan → execution transitions

## Install the complete setup

From GitHub:

```bash
pi install git:github.com/jephal/pi-setup#v0.0.1
```

Then reload Pi:

```text
/reload
```

## Install features independently

The feature packages can also be installed separately:

```bash
pi install git:github.com/jephal/pi-ask-questions#v0.0.1
pi install git:github.com/jephal/pi-plan-mode#v0.0.1
pi install git:github.com/jephal/pi-approval-modes#v0.0.1
```

## Development

This package is the local ecosystem root for the hand-rolled Pi packages. It references the feature packages as bundled dependencies and exposes their extension entry points through its `pi` manifest. `pi-plan-mode` is listed before `pi-approval-modes`; approval modes detect an existing `plan` tool and keep a standalone fallback without registering a duplicate.

The sibling package directories remain independently publishable while being developed together through this setup package. Moving them into a new directory would break their current Git remotes and local `file:` links, so the setup package acts as the monorepo-style integration boundary for now.

Add future feature packages to `dependencies`, `bundledDependencies`, and `pi.extensions`.

For reproducible releases, replace `#main` references with version tags such as `#v0.1.0` after tagging the feature repositories.
