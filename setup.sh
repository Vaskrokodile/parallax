#!/usr/bin/env bash
# setup.sh — install the parallel-agents workflow for Claude Code and/or Codex.
#
# Detects which tools are installed and wires up:
#   - MCP server registration (uses `npx -y @parallaxmcp/parallax-mcp`, no build needed)
#   - Subagent profiles (researcher + implementer)
#   - The /parallel orchestrator skill
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Vaskrokodile/parallax/main/setup.sh | bash
#   # or, after cloning:
#   ./setup.sh                # install globally (~/.claude, ~/.codex)
#   ./setup.sh --project      # install into the current project (.claude, .codex, .agents)
#   ./setup.sh --local-build  # use a local build instead of the npm package (for dev)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE="global"
USE_NPX=true

for arg in "$@"; do
  case "$arg" in
    --project)    SCOPE="project" ;;
    --local-build) USE_NPX=false ;;
    -h|--help)
      echo "Usage: setup.sh [--project] [--local-build]"
      echo ""
      echo "  --project      Install into the current project (.claude/, .codex/, .agents/)"
      echo "                 instead of globally (~/.claude/, ~/.codex/, ~/.agents/)."
      echo "  --local-build  Use a local build of the MCP server instead of the published"
      echo "                 npm package. Requires the mcp-server to be built first."
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# --- Determine MCP server command -------------------------------------------
if [ "$USE_NPX" = true ]; then
  MCP_COMMAND="npx"
  MCP_ARGS='-y @parallaxmcp/parallax-mcp'
  MCP_DESC="npm package (npx -y @parallaxmcp/parallax-mcp)"
else
  LOCAL_BUILD="$SCRIPT_DIR/mcp-server/dist/index.js"
  if [ ! -f "$LOCAL_BUILD" ]; then
    echo "Building MCP server locally..."
    (cd "$SCRIPT_DIR/mcp-server" && npm install && npm run build)
  fi
  MCP_COMMAND="node"
  MCP_ARGS="$LOCAL_BUILD"
  MCP_DESC="local build ($LOCAL_BUILD)"
fi

echo "MCP server: $MCP_DESC"
echo "Scope: $SCOPE"
echo ""

# --- Determine install paths ------------------------------------------------
if [ "$SCOPE" = "global" ]; then
  CLAUDE_HOME="$HOME/.claude"
  CODEX_HOME="$HOME/.codex"
  AGENTS_SKILLS_HOME="$HOME/.agents/skills"
else
  CLAUDE_HOME="$(pwd)/.claude"
  CODEX_HOME="$(pwd)/.codex"
  AGENTS_SKILLS_HOME="$(pwd)/.agents/skills"
fi

INSTALLED_CLAUDE=false
INSTALLED_CODEX=false

# --- Claude Code ------------------------------------------------------------
install_claude_code() {
  echo "==> Installing for Claude Code..."
  mkdir -p "$CLAUDE_HOME/agents" "$CLAUDE_HOME/skills/parallel"

  cp "$SCRIPT_DIR/claude-code/.claude/agents/researcher.md" "$CLAUDE_HOME/agents/"
  cp "$SCRIPT_DIR/claude-code/.claude/agents/implementer.md" "$CLAUDE_HOME/agents/"
  cp "$SCRIPT_DIR/claude-code/.claude/skills/parallel/SKILL.md" "$CLAUDE_HOME/skills/parallel/"
  echo "  Copied: agents/researcher.md, agents/implementer.md, skills/parallel/SKILL.md"

  # Register MCP server. Prefer `claude mcp add` if the CLI is available;
  # otherwise merge into config.json.
  if command -v claude >/dev/null 2>&1; then
    if [ "$SCOPE" = "global" ]; then
      claude mcp add -s user parallel_agents -- $MCP_COMMAND $MCP_ARGS 2>/dev/null || true
    else
      claude mcp add -s project parallel_agents -- $MCP_COMMAND $MCP_ARGS 2>/dev/null || true
    fi
    echo "  Registered MCP server via: claude mcp add"
  else
    # Merge into config.json manually.
    CONFIG="$CLAUDE_HOME/config.json"
    mkdir -p "$CLAUDE_HOME"
    if [ ! -f "$CONFIG" ]; then
      echo '{}' > "$CONFIG"
    fi
    # Use node to merge JSON safely (available since we need it for the server anyway).
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.parallel_agents = {
        command: '$MCP_COMMAND',
        args: '$MCP_ARGS'.split(' '),
        env: { PARALLEL_AGENTS_STATE_DIR: '.parallel-agents' }
      };
      fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "  Registered MCP server in: $CONFIG"
  fi

  INSTALLED_CLAUDE=true
  echo "  Done."
  echo ""
}

# --- Codex ------------------------------------------------------------------
install_codex() {
  echo "==> Installing for Codex..."
  mkdir -p "$CODEX_HOME/agents" "$AGENTS_SKILLS_HOME/parallel"

  cp "$SCRIPT_DIR/codex/.codex/agents/researcher.toml" "$CODEX_HOME/agents/"
  cp "$SCRIPT_DIR/codex/.codex/agents/implementer.toml" "$CODEX_HOME/agents/"
  cp "$SCRIPT_DIR/codex/.agents/skills/parallel/SKILL.md" "$AGENTS_SKILLS_HOME/parallel/"
  echo "  Copied: agents/researcher.toml, agents/implementer.toml, skills/parallel/SKILL.md"

  # Merge MCP server + [agents] settings into config.toml.
  # Codex config is TOML; we append a managed block. If the block already
  # exists, we skip to avoid duplicates.
  CONFIG="$CODEX_HOME/config.toml"
  mkdir -p "$CODEX_HOME"
  touch "$CONFIG"

  if ! grep -q 'mcp_servers.parallel_agents' "$CONFIG"; then
    cat >> "$CONFIG" <<EOF

# --- @parallaxmcp/parallax-mcp (managed by setup.sh) ---
[agents]
max_threads = 6
max_depth = 1

[mcp_servers.parallel_agents]
command = "$MCP_COMMAND"
args = [$(echo "$MCP_ARGS" | sed 's/\([^ ]*\)/"\1"/g' | sed 's/ /, /g')]
env = { PARALLEL_AGENTS_STATE_DIR = ".parallel-agents" }
default_tools_approval_mode = "approve"
EOF
    echo "  Appended MCP config to: $CONFIG"
  else
    echo "  MCP config already present in: $CONFIG (skipping)"
  fi

  INSTALLED_CODEX=true
  echo "  Done."
  echo ""
}

# --- Detect and install -----------------------------------------------------

# Claude Code: check for ~/.claude or the claude CLI
if [ -d "$HOME/.claude" ] || command -v claude >/dev/null 2>&1 || [ "$SCOPE" = "project" ]; then
  install_claude_code
else
  echo "-- Skipping Claude Code (no ~/.claude dir and no 'claude' CLI found)"
  echo "   To install for Claude Code later, re-run with --project or after installing Claude Code."
  echo ""
fi

# Codex: check for ~/.codex or the codex CLI
if [ -d "$HOME/.codex" ] || command -v codex >/dev/null 2>&1 || [ "$SCOPE" = "project" ]; then
  install_codex
else
  echo "-- Skipping Codex (no ~/.codex dir and no 'codex' CLI found)"
  echo "   To install for Codex later, re-run with --project or after installing Codex."
  echo ""
fi

# --- Summary ----------------------------------------------------------------
echo "============================================"
if [ "$INSTALLED_CLAUDE" = true ]; then
  echo "Claude Code:  installed ($SCOPE)"
  echo "  Skill:      /parallel"
  echo "  Agents:     researcher, implementer"
  echo "  MCP:        parallel_agents"
fi
if [ "$INSTALLED_CODEX" = true ]; then
  echo "Codex:        installed ($SCOPE)"
  echo "  Skill:      /parallel"
  echo "  Agents:     researcher, implementer"
  echo "  MCP:        parallel_agents"
fi
if [ "$INSTALLED_CLAUDE" = false ] && [ "$INSTALLED_CODEX" = false ]; then
  echo "Nothing was installed. Install Claude Code or Codex first, then re-run."
  exit 1
fi
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code and/or Codex so they pick up the new MCP server."
echo "  2. Add .parallel-agents/ to your project's .gitignore."
echo "  3. Try it:  /parallel <your task description>"
echo ""
echo "The blackboard state lives at .parallel-agents/state.json."
echo "Inspect a run with:  cat .parallel-agents/state.json | jq '.tasks[] | {id, status, claimedBy, summary}'"
