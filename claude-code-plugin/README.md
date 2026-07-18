# parallel-agents Claude Code plugin

A self-contained Claude Code plugin that bundles everything needed for the
parallel-agents workflow:

- **MCP server**: `parallel_agents` (via `.mcp.json`, uses `npx -y parallax-mcp`)
- **Subagents**: `researcher` (read-only research) and `implementer` (scoped code changes)
- **Skill**: `/parallel-agents:run` — the orchestrator that decomposes, spawns, and synthesizes

## Install

### Local (test from a clone)

```bash
claude --plugin-dir /path/to/parallax-mcp/claude-code-plugin
```

Or add it to your project's plugin config and restart Claude Code.

### From a marketplace

Once published to a marketplace:

```bash
/plugin install parallel-agents@<marketplace>
```

## Layout

```
claude-code-plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest
├── .mcp.json                # MCP server registration (npx -y parallax-mcp)
├── agents/
│   ├── researcher.md        # read-only research subagent
│   └── implementer.md       # scoped implementation subagent
└── skills/
    └── parallel/
        └── SKILL.md         # /parallel-agents:run orchestrator skill
```

## Usage

```
/parallel-agents:run Add login with sessions: a login route that sets a session cookie,
and a middleware that checks it on protected routes.
```

The orchestrator decomposes the task, publishes a plan to the blackboard, spawns
researcher + implementer subagents in parallel, and synthesizes results.

See the [main repo](https://github.com/Vaskrokodile/parallax) for full docs.
