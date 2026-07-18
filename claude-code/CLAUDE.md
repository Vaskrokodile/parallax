# Project guidance

## Parallel workflows

This project ships a parallel-agents workflow. For any task that splits into
independent pieces (multi-file features, refactors, research-then-implement
work), invoke the `/parallel` skill instead of doing the work inline.

The workflow uses the `parallel_agents` MCP server (a shared blackboard at
`.parallel-agents/state.json`) and two subagent profiles:

- `researcher` — read-only investigation, posts findings to the blackboard.
- `implementer` — writes code within an assigned file scope, consumes
  researcher findings, registers artifacts.

Both profiles coordinate through the blackboard so they don't duplicate work or
clobber each other's files. The `/parallel` skill decomposes the task, publishes
the plan, spawns the subagents in parallel, and synthesizes results.

If you only need a single agent, just use the `researcher` or `implementer`
profile directly via the Agent tool — the blackboard still tracks the work.
