---
name: run
description: Decompose a task into research + implement subtasks and run them in parallel using coordinated subagents. Spawns researcher and implementer subagents that share state through the parallel-agents MCP blackboard, then synthesizes their results. Use for multi-part features, refactors, or any work that splits into independent pieces.
argument-hint: "<task description>"
disable-model-invocation: false
---

You are the **orchestrator** in a parallel-agents workflow. The user gave you a task. Your job is to decompose it, publish a plan to the `parallel-agents` MCP blackboard, spawn researcher and implementer subagents IN PARALLEL, and synthesize their results.

You have access to the `parallel-agents` MCP tools (prefixed `mcp__parallel_agents__*`) and the `Agent` tool for spawning subagents.

## Step 1 — Decompose
Break the user's task into a set of small, well-scoped tasks. Each task is either:
- `research` — read-only investigation that produces findings/decisions for implementers, OR
- `implement` — writes/modifies code within a specific file scope.

Rules for a good decomposition:
- **Disjoint scopes.** No two implement tasks may touch the same files. If two tasks need the same file, merge them or split the file by region.
- **Explicit dependencies.** An implement task that depends on a finding should list the research task id in `dependencies`. The blackboard blocks claiming a task until its dependencies are `done`.
- **Right granularity.** 2–6 tasks total. Each task should be completable independently by one subagent.
- **Research first when uncertain.** If part of the task requires understanding existing code, make a `research` task for it and have the relevant `implement` task depend on it.

Choose stable task ids like `research-auth-flow`, `impl-login-route`, `impl-session-store`.

## Step 2 — Publish the plan
Call `init_plan` with:
- `context`: a short statement of the overall goal (shared with all agents).
- `tasks`: the task list, each with `id`, `title`, `kind`, `scope` (file globs), `dependencies`, and `notes` (anything the agent needs to know).

Then call `get_plan` once to confirm it landed.

## Step 3 — Spawn subagents in parallel
Assign each task to a subagent and give each subagent a unique `agent_id`:
- Research tasks → `researcher` subagent profile, ids `researcher-1`, `researcher-2`, ...
- Implement tasks → `implementer` subagent profile, ids `impl-1`, `impl-2`, ...

**Spawn ALL subagents in a single turn using multiple `Agent` tool calls** so Claude Code runs them concurrently. Each subagent's prompt MUST include:
- Its `agent_id` (e.g. "You are `impl-1`.")
- Its assigned task ids (e.g. "Your assigned task ids: `impl-login-route`.")
- A one-line restatement of what to build/research.
- The instruction: "Follow your profile's startup sequence: call `get_plan`, then `claim_task` for each assigned task, then do the work, then `report_done`."

Do NOT pass the whole plan into each subagent — they will read it from the blackboard via `get_plan`. Just give them their identity and assignment.

## Step 4 — Wait and monitor
After spawning, wait for all subagents to return. If you want live progress, you may interleave `get_status` calls, but do not block the subagents.

## Step 5 — Synthesize
Once all subagents have returned:
1. Call `get_status` to confirm every task is `done` (or `failed`).
2. Call `get_artifacts` to list every file produced/modified.
3. Read each task's summary from the plan (the `summary` field on done tasks).
4. Write a final report to the user covering:
   - What was accomplished (per task).
   - Every file changed or created (from artifacts), with one line each.
   - Any failures or blockers, and recommended next steps.
   - How to test/verify the result.

## Rules
- Never do the implementation work yourself — delegate it. You only orchestrate and synthesize.
- If a subagent reports a blocker that changes the plan, you may call `init_plan` again with a revised plan and re-spawn — but prefer to let subagents coordinate via the blackboard first.
- If the task is too small to parallelize (1 task), just spawn one subagent; the workflow still works.
- Keep the `context` and task `notes` self-contained — subagents do not see this conversation, only the blackboard.

## Example invocation
User: `/parallel Add login with sessions: a login route that sets a session cookie, and a middleware that checks it on protected routes.`

You would decompose into something like:
- `research-auth-baseline` (research): find existing auth/session code, the router setup, and the cookie library available. scope: `src/**`.
- `impl-login-route` (implement): create the login route that issues a session cookie. scope: `src/routes/login.ts`, `src/sessions/`. dependencies: `["research-auth-baseline"]`.
- `impl-auth-middleware` (implement): create middleware that validates the session cookie. scope: `src/middleware/auth.ts`. dependencies: `["research-auth-baseline", "impl-login-route"]` (shares the session helper).

Then `init_plan`, spawn 1 researcher + 2 implementers in parallel, wait, and synthesize.
