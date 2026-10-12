---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow. Visualization guidance: use `visualize` preview only while planning; persistent independent Excalidraw diagrams belong in Herdr's dedicated `visualization-viewer` pane. Open the derived Plan Board only explicitly with `plan_board({ action: "open" })`; it is a bounded display of Pi's authoritative plan, not an artifact or command pane. Terminal/browser viewer startup and artifact writes require normal execution after approval; the preserved browser viewer is non-default. Terminal viewer control is blocked in Plan and Review.

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Use the scout's fast preset and the planner's medium preset by default. Treat complex as a rare exception; override a step only when genuine ambiguity, high consequence, or a failed attempt justifies the extra cost. Do NOT implement - just return the plan.
