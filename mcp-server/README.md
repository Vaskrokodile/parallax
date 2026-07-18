# parallax-mcp

Blackboard MCP server for coordinating parallel subagents across Claude Code and Codex.

A stdio MCP server that provides a shared, file-backed coordination store. Subagents
claim tasks atomically, post findings, consume upstream results, register artifacts,
and report completion — all through MCP tools. State is persisted to
`.parallel-agents/state.json` with a cross-process lock, so it's safe even when each
subagent runs its own MCP server process (as Codex does).

## Tools

`init_plan` · `get_plan` · `claim_task` · `post_update` · `read_updates` ·
`register_artifact` · `get_artifacts` · `report_done` · `get_status` · `reset`

## Usage

This server is meant to be used with the parallel-agents skill/agent packs for
Claude Code and Codex. See the [main repo](https://github.com/Vaskrokodile/parallax)
for setup instructions and the full workflow.

To use standalone in any MCP client, add to your MCP config:

```json
{
  "mcpServers": {
    "parallel_agents": {
      "command": "npx",
      "args": ["-y", "@parallaxmcp/parallax-mcp"],
      "env": { "PARALLEL_AGENTS_STATE_DIR": ".parallel-agents" }
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm run smoke   # end-to-end + cross-process claim race test
```

MIT License.
