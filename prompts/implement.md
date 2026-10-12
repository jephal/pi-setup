---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow. Visualization guidance: use `visualize` preview for planning; persistent independent Excalidraw diagrams belong in Herdr's dedicated `visualization-viewer` pane. The derived Plan Board is separate: open it explicitly with `plan_board({ action: "open" })`; plan saves and checkpoint events update it without arbitrary commands or a second diagram pane. Mermaid and preview wireframes stay in Pi chat. Use `action: terminal_viewer` after approval; the preserved browser viewer is non-default and requires an explicit loopback URL request. Artifacts require an explicit project-relative `.excalidraw` path.

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Use fast for straightforward reconnaissance and medium by default for planning and implementation. Treat complex as a rare exception for genuinely ambiguous or high-consequence steps; override only the affected step rather than the whole chain.
