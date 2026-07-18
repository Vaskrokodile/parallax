# parallax

A portable **blackboard MCP server** + **skill/agent packs** that make Claude Code
and OpenAI Codex launch **parallel subagents that actually coordinate** — instead
of fanning out into isolated workers that duplicate work and clobber each other's
files.

```
                    ┌────────────────────────────────────────┐
                    │  /parallel  (orchestrator skill)       │
                    │  decomposes task → init_plan           │
                    └──────────────────┬─────────────────────┘
                                       │ spawns (parallel)
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
      researcher-1              implementer-1              implementer-2
            │                          │                          │
            │   claim / post_update / read_updates / report_done   │
            ▼                          ▼                          ▼
        ┌────────────────────────────────────────────────────────────┐
        │   parallel-agents MCP server (stdio, file-backed)          │
        │   .parallel-agents/state.json  (+ cross-process lock)      │
        └────────────────────────────────────────────────────────────┘
```

The orchestrator decomposes the task into `research` and `implement` tasks with
**disjoint file scopes** and **explicit dependencies**, publishes them to the
blackboard, spawns one subagent per task in parallel, and synthesizes the
results. Subagents claim tasks atomically, post findings, consume upstream
findings, register artifacts, and report done — all through MCP tools.

## Why this works when naive parallelism doesn't

- **Shared state.** Subagents don't share conversation history. The blackboard
  is the only place they meet: researchers post findings, implementers read them
  before coding.
- **Atomic ownership.** `claim_task` uses a cross-process file lock, so exactly
  one agent owns a task — even when each Codex subagent runs its own MCP server
  process.
- **Disjoint scopes.** The orchestrator assigns non-overlapping file globs to
  implementers, so parallel edits never conflict.
- **Dependencies.** An implement task lists its research task as a dependency;
  the blackboard blocks claiming it until the research is `done`.

## Install

Three options, from easiest to most control.

### Option A — One-command install script (recommended)

Detects Claude Code and/or Codex, copies the skill + agent files, and registers
the MCP server. Uses the published npm package — no clone or build needed.

```bash
curl -fsSL https://raw.githubusercontent.com/Vaskrokodile/parallax/main/setup.sh | bash
```

Or clone and run with options:

```bash
git clone https://github.com/Vaskrokodile/parallax.git
cd parallax
./setup.sh                 # global install (~/.claude, ~/.codex)
./setup.sh --project       # project-scoped (.claude, .codex, .agents)
./setup.sh --local-build   # use a local build instead of npm (for dev)
```

Then **restart Claude Code and/or Codex** so they pick up the new MCP server.

### Option B — Claude Code plugin

If you only use Claude Code, the plugin bundles everything (MCP + agents + skill)
in one installable unit:

```bash
# from a clone, test locally:
claude --plugin-dir /path/to/parallax-mcp/claude-code-plugin

# or once published to a marketplace:
/plugin install parallel-agents@<marketplace>
```

The skill is invoked as `/parallel-agents:run`.

### Option C — Manual install

Copy the packs by hand and register the MCP server yourself.

**Claude Code:**
```bash
cp -R claude-code/.claude  /your-project/.claude
# or for global: cp -R claude-code/.claude/*  ~/.claude/
```

Then register the MCP server (uses the npm package, no build needed):
```bash
claude mcp add parallel_agents -- npx -y parallax-mcp
```

**Codex:**
```bash
cp -R codex/.codex  /your-project/.codex
cp -R codex/.agents /your-project/.agents
cp codex/AGENTS.md  /your-project/AGENTS.md
```

The `.codex/config.toml` already references `npx -y parallax-mcp`.

In all cases, add `.parallel-agents/` to your project's `.gitignore`.

## Repository layout

```
parallax-mcp/
├── mcp-server/                  # the portable blackboard MCP server (npm package)
│   ├── src/
│   │   ├── store.ts             # file-backed atomic coordination store
│   │   └── index.ts             # MCP server: 10 tools
│   ├── scripts/smoke.js         # end-to-end + cross-process race test
│   └── package.json             # published as `parallax-mcp` on npm
├── claude-code/                 # manual pack for Claude Code
│   ├── .claude/
│   │   ├── agents/              # researcher.md, implementer.md
│   │   ├── skills/parallel/     # orchestrator skill (/parallel)
│   │   └── config.json          # MCP server registration
│   └── CLAUDE.md
├── claude-code-plugin/          # self-contained Claude Code plugin
│   ├── .claude-plugin/
│   │   └── plugin.json          # plugin manifest
│   ├── .mcp.json                # MCP server (npx -y parallax-mcp)
│   ├── agents/                  # researcher.md, implementer.md
│   └── skills/parallel/         # /parallel-agents:run
├── codex/                       # manual pack for Codex
│   ├── .codex/
│   │   ├── agents/              # researcher.toml, implementer.toml
│   │   └── config.toml          # [agents] + [mcp_servers.parallel_agents]
│   ├── .agents/skills/parallel/ # orchestrator skill (/parallel)
│   └── AGENTS.md
├── setup.sh                     # one-command installer for both tools
└── README.md
```

## MCP tools (the blackboard)

| Tool | Who calls it | Purpose |
| --- | --- | --- |
| `init_plan` | orchestrator | Create a plan with tasks (replaces any existing board). |
| `get_plan` | anyone | Read the full plan: tasks, statuses, updates, artifacts, agents. |
| `claim_task` | subagent | Atomically claim a pending task. Fails if claimed/done/blocked. |
| `post_update` | subagent | Post a finding / decision / blocker / progress note. |
| `read_updates` | subagent | Read updates from other agents (filter by task/key/agent/since). |
| `register_artifact` | subagent | Register a file produced/modified by a task. |
| `get_artifacts` | anyone | List artifacts, optionally filtered. |
| `report_done` | subagent | Mark a task done/failed with a self-contained summary. |
| `get_status` | orchestrator | Compact board status: per-task, per-agent, totals. |
| `reset` | orchestrator | Clear the board. |

State lives at `$PARALLEL_AGENTS_STATE_DIR/state.json` (default
`<cwd>/.parallel-agents/state.json`). Writes are atomic (temp file + rename);
mutations run under a `proper-lockfile` cross-process lock.

## Usage

In either tool:

```
/parallel Add login with sessions: a login route that sets a session cookie,
and a middleware that checks it on protected routes.
```

(With the Claude Code plugin, use `/parallel-agents:run` instead of `/parallel`.)

The orchestrator will:
1. Decompose into research + implement tasks with disjoint scopes and deps.
2. Call `init_plan`, then spawn `researcher` and `implementer` subagents in
   parallel (one per task).
3. Each subagent claims its task, reads upstream findings, does the work, posts
   updates, registers artifacts, and calls `report_done`.
4. The orchestrator polls `get_status`, then synthesizes a final report with
   every changed file and how to test.

For a single-agent task, skip the skill and delegate directly to `researcher`
or `implementer` — the blackboard still tracks the work.

## Inspecting the board

The blackboard is just JSON on disk:

```bash
cat .parallel-agents/state.json | jq '.tasks[] | {id, status, claimedBy, summary}'
```

Great for debugging a run in progress or after the fact.

## Development

```bash
git clone https://github.com/Vaskrokodile/parallax.git
cd parallax/mcp-server
npm install
npm run build
npm run smoke      # verifies tools + cross-process claim race (should print OK)
```

## Publishing

The MCP server is published to npm as `parallax-mcp`. To publish a new
version:

```bash
cd mcp-server
npm version patch       # or minor / major
npm publish             # prepublishOnly builds automatically
```

The Claude Code plugin can be distributed via a marketplace or git URL. The
Codex pack is manual (copy files + config).

## Notes & caveats

- **Cost.** Each subagent is its own session with its own context window. Fan
  out deliberately — 2–6 tasks is the sweet spot. More tasks = more spend.
- **Nesting.** The orchestrator is one level deep by design. Subagents do not
  spawn further subagents (Codex `max_depth = 1`; Claude Code subagents don't
  nest by default). Raise `max_depth` only if you really need recursive fan-out.
- **Permissions.** Subagents inherit the parent's permission/sandbox mode. In
  Codex, `researcher` pins `sandbox_mode = "read-only"` and `implementer` pins
  `workspace-write`. In Claude Code, the `researcher` profile omits edit tools.
- **State dir.** Add `.parallel-agents/` to `.gitignore`. Set
  `PARALLEL_AGENTS_STATE_DIR` to relocate it.
- **Codex process model.** Each Codex subagent session starts its own MCP server
  process. The blackboard is file-backed with a cross-process lock, so this is
  safe — verified by `npm run smoke`'s 8-process claim race.
- **MCP servers load at startup.** After installing, restart Claude Code or
  Codex so they pick up the new MCP server. You can't add an MCP server
  mid-session.

MIT License.
