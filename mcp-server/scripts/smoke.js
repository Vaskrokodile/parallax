#!/usr/bin/env node
// Smoke test: drives the MCP server over stdio with JSON-RPC, then runs a
// concurrent claim_task race across separate server processes to verify the
// file lock makes claims atomic cross-process.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SERVER = path.join(__dirname, "..", "dist", "index.js");
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pa-smoke-"));
process.env.PARALLEL_AGENTS_STATE_DIR = STATE_DIR;

function rpc(proc, msg) {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    const onLine = (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.id === id) {
          proc.stdout.off("data", onData);
          resolve(obj);
        }
      } catch {}
    };
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify(msg) + "\n");
    setTimeout(() => reject(new Error("timeout for id=" + id)), 5000).unref();
  });
}

async function withServer(fn) {
  const proc = spawn("node", [SERVER], {
    env: { ...process.env, PARALLEL_AGENTS_STATE_DIR: STATE_DIR },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    await rpc(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
    // notifications/initialized is a notification — no response expected.
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    await new Promise((r) => setImmediate(r));
    return await fn(proc);
  } finally {
    proc.kill();
  }
}

(async () => {
  // 1. tools/list
  await withServer(async (proc) => {
    const list = await rpc(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = list.result.tools.map((t) => t.name).sort();
    const expected = ["claim_task", "get_artifacts", "get_plan", "get_status", "init_plan", "post_update", "read_updates", "register_artifact", "report_done", "reset"];
    console.log("tools/list:", names.join(","));
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("tool list mismatch: " + names.join(","));
  });

  // 2. init_plan + get_plan + claim (single process)
  await withServer(async (proc) => {
    const init = await rpc(proc, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "init_plan", arguments: {
      context: "smoke test plan",
      tasks: [
        { id: "r1", title: "research a", kind: "research", scope: ["src/a/**"] },
        { id: "i1", title: "impl b", kind: "implement", scope: ["src/b/**"], dependencies: ["r1"] },
      ],
    } } });
    if (!init.result.content[0].text.includes("r1")) throw new Error("init_plan bad response");

    const claim = await rpc(proc, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "claim_task", arguments: { task_id: "r1", agent_id: "researcher-1", role: "researcher" } } });
    const c = JSON.parse(claim.result.content[0].text);
    if (!c.ok) throw new Error("claim r1 failed: " + JSON.stringify(c));

    // dependency-blocked claim
    const blocked = await rpc(proc, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "claim_task", arguments: { task_id: "i1", agent_id: "impl-1", role: "implementer" } } });
    const b = JSON.parse(blocked.result.content[0].text);
    if (b.ok) throw new Error("i1 should be blocked by r1 dependency");

    // report_done + then claim i1
    await rpc(proc, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "report_done", arguments: { agent_id: "researcher-1", task_id: "r1", summary: "found a" } } });
    const claim2 = await rpc(proc, { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "claim_task", arguments: { task_id: "i1", agent_id: "impl-1", role: "implementer" } } });
    const c2 = JSON.parse(claim2.result.content[0].text);
    if (!c2.ok) throw new Error("claim i1 after r1 done failed: " + JSON.stringify(c2));
  });

  // 3. cross-process claim race: 8 separate processes try to claim the same task
  //    exactly one must win.
  await withServer(async (proc) => {
    await rpc(proc, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "init_plan", arguments: {
      context: "race", tasks: [{ id: "race-1", title: "race", kind: "research" }],
    } } });
  });

  const N = 8;
  const racers = [];
  for (let i = 0; i < N; i++) {
    racers.push(withServer(async (proc) => {
      const r = await rpc(proc, { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "claim_task", arguments: { task_id: "race-1", agent_id: `racer-${i}`, role: "researcher" } } });
      return JSON.parse(r.result.content[0].text);
    }));
  }
  const results = await Promise.all(racers);
  const winners = results.filter((r) => r.ok);
  console.log("race winners:", winners.length, "winner:", winners[0]?.task?.claimedBy);
  if (winners.length !== 1) throw new Error(`expected exactly 1 winner, got ${winners.length}`);

  console.log("OK");
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
