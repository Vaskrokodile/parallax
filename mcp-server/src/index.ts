#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { store } from "./store.js";

const server = new McpServer({
  name: "parallel-agents",
  version: "0.1.0",
});

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

const taskInputSchema = z.object({
  id: z.string().describe("Stable task id, e.g. 'research-auth' or 'impl-login'."),
  title: z.string(),
  kind: z.enum(["research", "implement"]),
  scope: z.array(z.string()).optional().describe("File globs/paths this task's agent may touch."),
  dependencies: z.array(z.string()).optional().describe("Task ids that must be 'done' before this task can be claimed."),
  notes: z.string().optional(),
});

server.tool(
  "init_plan",
  "Orchestrator only. Create a fresh plan with a list of tasks, replacing any existing board. " +
    "Returns the created plan with all tasks in 'pending' status.",
  { context: z.string(), tasks: z.array(taskInputSchema) },
  async (args) => text(await store.initPlan(args.context, args.tasks as any[]))
);

server.tool(
  "get_plan",
  "Read the current plan: all tasks with status/claim info, updates, artifacts, and agents. " +
    "Subagents call this at startup to learn their assigned tasks and dependencies.",
  {},
  async () => text(await store.getPlan())
);

server.tool(
  "claim_task",
  "Atomically claim a pending task for an agent. Fails if already claimed by someone else, " +
    "already done, or has unfinished dependencies. Returns the task on success or a reason on failure. " +
    "Subagents should call this before starting work, and retry on a different task if it fails.",
  {
    task_id: z.string(),
    agent_id: z.string().describe("Your assigned agent id (e.g. 'researcher-1')."),
    role: z.string().describe("Your role: 'researcher' or 'implementer'."),
  },
  async (args) => text(await store.claimTask(args.task_id, args.agent_id, args.role))
);

server.tool(
  "post_update",
  "Post a progress update or finding to the shared board. Other agents can read it via read_updates. " +
    "Use meaningful keys like 'finding', 'blocker', 'decision', 'progress'. Keep values concise.",
  {
    agent_id: z.string(),
    key: z.string(),
    value: z.string(),
    task_id: z.string().optional().describe("Optional task id this update relates to."),
  },
  async (args) => text(await store.postUpdate(args.agent_id, args.key, args.value, args.task_id ?? null))
);

server.tool(
  "read_updates",
  "Read updates posted by any agent. Filter by task_id, key, agent_id, or since (ISO timestamp). " +
    "Implementers should call this to consume findings from researchers before they start coding.",
  {
    task_id: z.string().optional(),
    key: z.string().optional(),
    agent_id: z.string().optional(),
    since: z.string().optional().describe("ISO timestamp; only updates after this are returned."),
  },
  async (args) =>
    text(
      await store.readUpdates({
        taskId: args.task_id ?? null,
        key: args.key ?? null,
        agentId: args.agent_id ?? null,
        since: args.since ?? null,
      })
    )
);

server.tool(
  "register_artifact",
  "Register a file you produced or modified as an artifact of a task. Lets the orchestrator and other " +
    "agents know what files came out of a task. Call this for every file you create or meaningfully change.",
  {
    agent_id: z.string(),
    task_id: z.string(),
    path: z.string().describe("Repo-relative file path."),
    description: z.string().describe("What this file is / what changed."),
  },
  async (args) => text(await store.registerArtifact(args.agent_id, args.task_id, args.path, args.description))
);

server.tool(
  "get_artifacts",
  "List registered artifacts, optionally filtered by task_id or agent_id.",
  { task_id: z.string().optional(), agent_id: z.string().optional() },
  async (args) => text(await store.getArtifacts({ taskId: args.task_id ?? null, agentId: args.agent_id ?? null }))
);

server.tool(
  "report_done",
  "Mark a task done (or failed) with a summary. The summary is what the orchestrator reads to synthesize " +
    "the final result, so make it self-contained: what changed, key file paths, and anything downstream agents need.",
  {
    agent_id: z.string(),
    task_id: z.string(),
    summary: z.string(),
    status: z.enum(["done", "failed"]).optional().describe("Defaults to 'done'."),
  },
  async (args) => text(await store.reportDone(args.agent_id, args.task_id, args.summary, args.status ?? "done"))
);

server.tool(
  "get_status",
  "Compact board status: per-task status, per-agent claims, and totals. Orchestrator polls this to decide " +
    "when all work is finished and what to synthesize.",
  {},
  async () => text(await store.getStatus())
);

server.tool(
  "reset",
  "Clear the entire board. Orchestrator-only; call before init_plan if you want a clean slate.",
  {},
  async () => text(await store.reset())
);

// ---- Run -------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[parallax-mcp] ready. state: ${store.statePath()}\n`);
}

main().catch((err) => {
  process.stderr.write(`[parallax-mcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
