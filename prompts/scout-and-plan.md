---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Use the scout's fast preset and the planner's medium preset by default. Treat complex as a rare exception; override a step only when genuine ambiguity, high consequence, or a failed attempt justifies the extra cost. Do NOT implement - just return the plan.
