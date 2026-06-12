// Port of src/core/resolve/lsp/daemon.py — a persistent LSP daemon. The one-time project index
// (~5.5s for TS) is paid ONCE per machine and reused by every later scan/invocation. The daemon holds
// a warm LspResolver (its LspPool keeps the servers alive) behind a unix socket; clients
// (DaemonResolver) connect-or-spawn it and send newline-delimited JSON requests. It shuts itself down
// after an idle TTL. If it can't be reached, the client degrades to in-process LSP, then the floor.
//
// Protocol (one JSON object per line, request → response):
//   {"op":"resolve_module","repo":..,"file":..,"source":..}  -> {"result": <relpath|null>}
//   {"op":"resolve_symbol","repo":..,"file":..,"line":..,"col":..} -> {"result": [relpath,line]|null}
//   {"op":"ping"}      -> {"result":"pong"}
//   {"op":"shutdown"}  -> {"result":"bye"}   (then the daemon exits — used by tests)
import { createServer, createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
import { LspResolver, defaultSocket } from "./resolver.js";

export { defaultSocket };

const IDLE_TTL = 900_000;   // ms with no connection before the daemon frees its servers and exits
const SPAWN_WAIT = 30_000;  // ms to wait for a freshly-spawned daemon's socket

function bunBin(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const installed = home ? `${home}${sep}.bun${sep}bin${sep}bun` : "";
  if (installed) { try { if (statSync(installed).isFile()) return installed; } catch { /* fall through */ } }
  for (const d of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!d) continue;
    const cand = `${d}${sep}bun`;
    try { if (statSync(cand).isFile()) return cand; } catch { /* keep looking */ }
  }
  return "bun";
}

// --------------------------------------------------------------------------- daemon side
export function serve(sockPath: string): void {
  const res = new LspResolver(false);                // the daemon does LSP-only; clients add the floor
  if (existsSync(sockPath)) { try { unlinkSync(sockPath); } catch { /* ignore */ } }

  let idleTimer: ReturnType<typeof setTimeout>;
  const srv = createServer();
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown(), IDLE_TTL); };
  const shutdown = () => {
    try { res.pool.shutdown_all(); } catch { /* ignore */ }
    srv.close();
    if (existsSync(sockPath)) { try { unlinkSync(sockPath); } catch { /* ignore */ } }
    process.exit(0);
  };

  srv.on("connection", (conn: Socket) => {
    clearTimeout(idleTimer);
    let buf = "";
    conn.on("data", async (chunk) => {
      buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: any;
        try { req = JSON.parse(line); } catch { continue; }
        if (req.op === "shutdown") { conn.write(JSON.stringify({ result: "bye" }) + "\n"); conn.end(); shutdown(); return; }
        let out: any = null;
        try {
          if (req.op === "resolve_module") out = await res.resolve_module(req.repo, req.file, req.source);
          else if (req.op === "resolve_symbol") out = await res.resolve_symbol(req.repo, req.file, req.line, req.col);
          else if (req.op === "ping") out = "pong";
        } catch { out = null; }
        conn.write(JSON.stringify({ result: out ?? null }) + "\n");
      }
    });
    conn.on("close", () => armIdle());
    conn.on("error", () => { /* client vanished */ });
  });

  srv.listen(sockPath, () => armIdle());
  srv.on("error", () => process.exit(1));
}

// --------------------------------------------------------------------------- client side
function connect(sockPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(sockPath);
    const onErr = (e: Error) => { s.destroy(); reject(e); };
    s.once("error", onErr);
    s.once("connect", () => { s.removeListener("error", onErr); s.setTimeout(timeoutMs); resolve(s); });
  });
}

// Connect to the daemon, spawning a detached one if absent. Returns a socket, or rejects.
async function ensureDaemon(sockPath: string): Promise<Socket> {
  try { return await connect(sockPath, 60_000); } catch { /* spawn one below */ }
  const self = fileURLToPath(import.meta.url);
  const child = spawn(bunBin(), [self, sockPath], { detached: true, stdio: "ignore" });
  child.unref();
  const end = Date.now() + SPAWN_WAIT;
  while (Date.now() < end) {
    try { return await connect(sockPath, 60_000); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("seam-lsp daemon did not come up");
}

// One request → its `result`. Rejects on connect/IO failure (caller degrades).
export async function call(sockPath: string, req: Record<string, unknown>, timeout = 60.0): Promise<any> {
  const s = await ensureDaemon(sockPath);
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => { s.destroy(); fn(); };
    s.setTimeout(timeout * 1000, () => done(() => reject(new Error("daemon timed out"))));
    s.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        try { done(() => resolve(JSON.parse(line).result ?? null)); }
        catch { done(() => reject(new Error("daemon returned non-JSON"))); }
      }
    });
    s.on("error", (e) => done(() => reject(e)));
    s.on("close", () => { if (!buf.includes("\n")) reject(new Error("daemon closed the connection")); });
    s.write(JSON.stringify(req) + "\n");
  });
}

// Run as a standalone daemon: `bun daemon.ts [sock]`.
if ((import.meta as any).main) serve(process.argv[2] || defaultSocket());
