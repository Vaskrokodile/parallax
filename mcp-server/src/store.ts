import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as lockfile from "proper-lockfile";

export type TaskKind = "research" | "implement";
export type TaskStatus = "pending" | "claimed" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  /** File globs / paths this task's agent may read or modify. Advisory boundary. */
  scope: string[];
  /** Task ids that must reach 'done' before this task should be claimed. */
  dependencies: string[];
  notes: string;
  status: TaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  doneAt: string | null;
  summary: string | null;
}

export interface Update {
  id: string;
  agentId: string;
  taskId: string | null;
  key: string;
  value: string;
  ts: string;
}

export interface Artifact {
  id: string;
  agentId: string;
  taskId: string;
  path: string;
  description: string;
  ts: string;
}

export interface AgentInfo {
  agentId: string;
  role: string;
  claimedTaskIds: string[];
  lastSeen: string;
}

export interface PlanState {
  planId: string | null;
  createdAt: string;
  context: string;
  tasks: Task[];
  updates: Update[];
  artifacts: Artifact[];
  agents: Record<string, AgentInfo>;
}

const EMPTY: PlanState = {
  planId: null,
  createdAt: "",
  context: "",
  tasks: [],
  updates: [],
  artifacts: [],
  agents: {},
};

function stateDir(): string {
  const override = process.env.PARALLEL_AGENTS_STATE_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.resolve(process.cwd(), ".parallel-agents");
}

function stateFile(): string {
  return path.join(stateDir(), "state.json");
}

function ensureDir(): void {
  fs.mkdirSync(stateDir(), { recursive: true });
}

function readRaw(): PlanState {
  const f = stateFile();
  if (!fs.existsSync(f)) return structuredClone(EMPTY);
  try {
    const raw = fs.readFileSync(f, "utf8");
    const parsed = JSON.parse(raw) as PlanState;
    // Defensive defaults so older states don't break newer code.
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      agents: parsed.agents ?? {},
      updates: parsed.updates ?? [],
      artifacts: parsed.artifacts ?? [],
      tasks: parsed.tasks ?? [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

function writeRaw(s: PlanState): void {
  ensureDir();
  const f = stateFile();
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  // Atomic rename so concurrent readers never see a half-written file.
  fs.renameSync(tmp, f);
}

/**
 * Run a read-modify-write under an exclusive cross-process lock.
 * proper-lockfile uses a sibling .lock file; it works across separate
 * MCP server processes (e.g. one per Codex subagent session).
 */
async function mutate<T>(fn: (s: PlanState) => { state: PlanState; result: T }): Promise<T> {
  ensureDir();
  const f = stateFile();
  // Touch the file so the lock target exists.
  if (!fs.existsSync(f)) writeRaw(structuredClone(EMPTY));
  const release = await lockfile.lock(f, { retries: { forever: true, minTimeout: 25, maxTimeout: 250 } });
  try {
    const s = readRaw();
    const { state, result } = fn(s);
    writeRaw(state);
    return result;
  } finally {
    await release();
  }
}

function now(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function touchAgent(s: PlanState, agentId: string, role: string): void {
  if (!agentId) return;
  const existing = s.agents[agentId];
  s.agents[agentId] = {
    agentId,
    role: role || existing?.role || "unknown",
    claimedTaskIds: existing?.claimedTaskIds ?? [],
    lastSeen: now(),
  };
}

export interface InitTaskInput {
  id: string;
  title: string;
  kind: TaskKind;
  scope?: string[];
  dependencies?: string[];
  notes?: string;
}

export const store = {
  statePath(): string {
    return stateFile();
  },

  async initPlan(context: string, tasks: InitTaskInput[]): Promise<PlanState> {
    return mutate((s) => {
      const planId = uid("plan");
      const next: PlanState = {
        ...structuredClone(EMPTY),
        planId,
        createdAt: now(),
        context,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          scope: t.scope ?? [],
          dependencies: t.dependencies ?? [],
          notes: t.notes ?? "",
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          doneAt: null,
          summary: null,
        })),
      };
      return { state: next, result: next };
    });
  },

  async getPlan(): Promise<PlanState> {
    return mutate((s) => ({ state: s, result: s }));
  },

  async claimTask(taskId: string, agentId: string, role: string): Promise<{ ok: boolean; task: Task | null; reason?: string }> {
    return mutate<{ ok: boolean; task: Task | null; reason?: string }>((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) return { state: s, result: { ok: false, task: null, reason: `No task with id '${taskId}'` } };
      if (t.status === "done") return { state: s, result: { ok: false, task: t, reason: `Task '${taskId}' is already done` } };
      if (t.status === "claimed" && t.claimedBy !== agentId) {
        return { state: s, result: { ok: false, task: t, reason: `Task '${taskId}' already claimed by '${t.claimedBy}'` } };
      }
      // Check dependencies are done.
      const blocked = t.dependencies
        .filter((dep) => {
          const d = s.tasks.find((x) => x.id === dep);
          return d && d.status !== "done";
        });
      if (blocked.length > 0) {
        return { state: s, result: { ok: false, task: t, reason: `Dependencies not done: ${blocked.join(", ")}` } };
      }
      t.status = "claimed";
      t.claimedBy = agentId;
      t.claimedAt = now();
      touchAgent(s, agentId, role);
      const a = s.agents[agentId];
      if (a && !a.claimedTaskIds.includes(taskId)) a.claimedTaskIds.push(taskId);
      return { state: s, result: { ok: true, task: t } };
    });
  },

  async postUpdate(agentId: string, key: string, value: string, taskId: string | null): Promise<Update> {
    return mutate((s) => {
      const u: Update = { id: uid("upd"), agentId, taskId, key, value, ts: now() };
      s.updates.push(u);
      touchAgent(s, agentId, "unknown");
      return { state: s, result: u };
    });
  },

  async readUpdates(opts: { taskId?: string | null; key?: string | null; agentId?: string | null; since?: string | null }): Promise<Update[]> {
    return mutate((s) => {
      let out = s.updates.slice();
      if (opts.taskId) out = out.filter((u) => u.taskId === opts.taskId);
      if (opts.key) out = out.filter((u) => u.key === opts.key);
      if (opts.agentId) out = out.filter((u) => u.agentId === opts.agentId);
      if (opts.since) out = out.filter((u) => u.ts > (opts.since as string));
      return { state: s, result: out };
    });
  },

  async registerArtifact(agentId: string, taskId: string, artifactPath: string, description: string): Promise<Artifact> {
    return mutate((s) => {
      const a: Artifact = { id: uid("art"), agentId, taskId, path: artifactPath, description, ts: now() };
      s.artifacts.push(a);
      touchAgent(s, agentId, "unknown");
      return { state: s, result: a };
    });
  },

  async getArtifacts(opts: { taskId?: string | null; agentId?: string | null }): Promise<Artifact[]> {
    return mutate((s) => {
      let out = s.artifacts.slice();
      if (opts.taskId) out = out.filter((a) => a.taskId === opts.taskId);
      if (opts.agentId) out = out.filter((a) => a.agentId === opts.agentId);
      return { state: s, result: out };
    });
  },

  async reportDone(agentId: string, taskId: string, summary: string, status: "done" | "failed"): Promise<{ ok: boolean; task: Task | null; reason?: string }> {
    return mutate<{ ok: boolean; task: Task | null; reason?: string }>((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) return { state: s, result: { ok: false, task: null, reason: `No task with id '${taskId}'` } };
      t.status = status;
      t.doneAt = now();
      t.summary = summary;
      touchAgent(s, agentId, "unknown");
      return { state: s, result: { ok: true, task: t } };
    });
  },

  async getStatus(): Promise<{
    planId: string | null;
    totals: { pending: number; claimed: number; done: number; failed: number; total: number };
    tasks: { id: string; title: string; status: TaskStatus; claimedBy: string | null }[];
    agents: AgentInfo[];
    updates: number;
    artifacts: number;
  }> {
    return mutate((s) => {
      const totals = { pending: 0, claimed: 0, done: 0, failed: 0, total: s.tasks.length };
      for (const t of s.tasks) totals[t.status]++;
      return {
        state: s,
        result: {
          planId: s.planId,
          totals,
          tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, claimedBy: t.claimedBy })),
          agents: Object.values(s.agents),
          updates: s.updates.length,
          artifacts: s.artifacts.length,
        },
      };
    });
  },

  async reset(): Promise<{ ok: boolean }> {
    return mutate((_s) => ({ state: structuredClone(EMPTY), result: { ok: true } }));
  },
};

// Silence the unused-import linter for os (kept for potential tmp paths).
void os;
