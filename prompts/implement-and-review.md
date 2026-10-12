---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow. Visualization guidance: use `visualize` preview for planning; persistent independent Excalidraw diagrams belong in Herdr's dedicated `visualization-viewer` pane. The derived Plan Board is separate: open it explicitly with `plan_board({ action: "open" })`; plan saves and checkpoint events update it without arbitrary commands or a second diagram pane. Mermaid and preview wireframes stay in Pi chat. Use `action: terminal_viewer` after approval; the preserved browser viewer is non-default and requires an explicit loopback URL request. Artifacts require an explicit project-relative `.excalidraw` path.

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Use medium for the normal worker/reviewer flow. Choose fast for clear low-risk work and treat complex as a rare exception for security, concurrency, architectural ambiguity, difficult debugging, or a failed medium attempt; upgrade only the affected step.
