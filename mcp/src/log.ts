// File-backed diagnostic log for the MCP server. The server's stdout/stderr are JSON-RPC pipes to the host
// (Copilot/Claude) — NOT readable as logs — so a long or timed-out tool call leaves no trace the user can
// inspect (exactly the "I can't find any log file" gap). This sink mirrors every tool call, the engine
// command, the engine's streamed progress/timing, durations, and errors to a real file. Best-effort: a
// logging failure must never break a tool call. Path: $SEAM_MCP_LOG, else ~/.seam/logs/seam-mcp.log.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function resolveLogPath(): string {
  const env = process.env.SEAM_MCP_LOG;
  if (env && env.trim()) return env.trim();
  return join(homedir(), ".seam", "logs", "seam-mcp.log");
}

export const LOG_PATH = resolveLogPath();
let _ready = false;

// Append one timestamped line. Never throws (a read-only FS / bad path silently disables logging).
export function log(msg: string): void {
  try {
    if (!_ready) { mkdirSync(dirname(LOG_PATH), { recursive: true }); _ready = true; }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging is best-effort — never break a tool call over it */ }
}

// A monotonic-ish call id so a call's start/progress/end lines can be correlated in the log. Plain counter
// (no Date.now needed) — uniqueness within a server process is all we need.
let _seq = 0;
export const nextCallId = (): string => `c${++_seq}`;
