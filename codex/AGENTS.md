# Project guidance

## Parallel workflows

This project ships a parallel-agents workflow. For any task that splits into
independent pieces (multi-file features, refactors, research-then-implement
work), invoke the `$parallel` skill instead of doing the work inline.

The workflow uses the `parallel_agents` MCP server (a shared blackboard at
`.parallel-agents/state.json`) and two custom subagents defined in
`.codex/agents/`:

- `researcher` — read-only investigation, posts findings to the blackboard.
- `implementer` — writes code within an assigned file scope, consumes
  researcher findings, registers artifacts.

Both coordinate through the blackboard so they don't duplicate work or clobber
each other's files. The `$parallel` skill decomposes the task, publishes the
plan, spawns the subagents in parallel, and synthesizes results.

When a task is small enough to be one agent, delegate directly to `researcher`
or `implementer` — the blackboard still tracks the work.

### Notes for Codex
- Subagent concurrency is capped by `agents.max_threads` in `.codex/config.toml`
  (default 6). Raise it if you fan out to more tasks.
- Each Codex subagent session starts its own MCP server process. The blackboard
  is file-backed with a cross-process lock, so all subagents read/write the same
  `.parallel-agents/state.json` safely.
- Subagents inherit your sandbox/permission mode. The `researcher` profile sets
  `sandbox_mode = "read-only"`; `implementer` sets `workspace-write`.
