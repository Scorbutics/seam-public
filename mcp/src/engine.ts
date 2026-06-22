// Thin adapter over the stateless Seam engine. The MCP server NEVER reimplements decomposition —
// it locates the same CLI/binary every other client uses and consumes the --emit-seams JSON
// contract (docs/SEAM_JSON_CONTRACT.md). No daemon, no resident state: one subprocess per call.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");   // mcp/src → repo root

function bunPath(): string {
  const candidate = join(homedir(), ".bun", "bin", "bun");
  return existsSync(candidate) ? candidate : "bun";
}

// Locate the engine: $SEAM_BIN (an explicit packaged engine) → the esbuilt dist bundle (`bun run build`,
// fast: no per-call transpile) → bun + the source CLI (always correct, ~40ms startup).
// NOTE: we deliberately do NOT auto-prefer a `ts/dist/seam` single binary. `bun build --compile` drops
// web-tree-sitter's core wasm, so that binary ABORTS on the first parse — auto-preferring it would let a
// stray broken build silently break every call. A working packaged engine is opted in via SEAM_BIN.
export function engineInvocation(): { cmd: string; pre: string[]; env?: Record<string, string> } {
  const envBin = process.env.SEAM_BIN;
  if (envBin && existsSync(envBin) && statSync(envBin).isFile()) return { cmd: envBin, pre: [] };
  const bundle = join(REPO_ROOT, "ts", "dist", "seam.cjs");
  if (existsSync(bundle)) return { cmd: bunPath(), pre: [bundle], env: { SEAM_WASM_DIR: join(REPO_ROOT, "ts", "dist", "wasm") } };
  return { cmd: bunPath(), pre: [join(REPO_ROOT, "ts", "src", "cli", "decompose.ts")] };
}

export class EngineError extends Error {}

// Whether the engine can serve its OWN LLM passes from a local binary (claude/copilot). Asks the engine
// itself (--check-backend) so the resolution logic stays the engine's source-of-truth — we don't
// re-scan PATH / CLAUDE_BIN / COPILOT_BIN here. Cached: a server-lifetime fact (binaries don't appear
// mid-run). Returns the backend kind ("claude"|"copilot") or null when none resolves.
let _backendKind: string | null | undefined;
export function backendKind(cwd = REPO_ROOT): string | null {
  if (_backendKind !== undefined) return _backendKind;
  const { cmd, pre, env } = engineInvocation();
  const proc = spawnSync(cmd, [...pre, "--check-backend"], { cwd, encoding: "utf-8", maxBuffer: 1 << 20, env: { ...process.env, ...env } });
  _backendKind = proc.status === 0 ? (proc.stdout || "").trim() || "unknown" : null;
  return _backendKind;
}

// Run the engine with FLAGS (everything after the entry). Returns captured stdout — the engine writes
// its artifacts to the --emit-* files the caller passes, and a one-line status to stdout/stderr.
export function runEngine(flags: string[], cwd = REPO_ROOT, extraEnv?: Record<string, string>): { stdout: string; stderr: string } {
  const { cmd, pre, env } = engineInvocation();
  const proc = spawnSync(cmd, [...pre, ...flags], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env, ...extraEnv } });
  if (proc.error) throw new EngineError(`could not run the Seam engine (${cmd}): ${proc.error.message}`);
  if (proc.status !== 0)
    throw new EngineError(`Seam engine failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").trim().slice(0, 600)}`);
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

// ASYNC engine run — the same invocation as runEngine, but via a non-blocking spawn that STREAMS stderr
// line-by-line to `onLine` as it arrives. Critical for LLM runs (binary mode): spawnSync would freeze the
// server's event loop for the whole grow, so it can't forward progress or keep the request alive and the
// host (Copilot) hits its request deadline while the engine is still working. Streaming unblocks the loop
// AND lets the caller forward `@@SEAM_PROGRESS@@` markers as MCP progress + mirror everything to the log.
export function runEngineAsync(
  flags: string[], onLine?: (line: string) => void, cwd = REPO_ROOT, extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const { cmd, pre, env } = engineInvocation();
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, [...pre, ...flags], { cwd, env: { ...process.env, ...env, ...extraEnv } });
    let stdout = "", stderr = "", buf = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });   // drain so the pipe never blocks the child
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (!onLine) return;
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line) onLine(line); }
    });
    proc.on("error", (e) => reject(new EngineError(`could not run the Seam engine (${cmd}): ${e.message}`)));
    proc.on("close", (code) => {
      if (buf && onLine) onLine(buf);
      if (code !== 0) reject(new EngineError(`Seam engine failed (exit ${code}): ${(stderr || stdout || "").trim().slice(0, 600)}`));
      else resolve({ stdout, stderr });
    });
  });
}

// A scratch dir for one tool call's temp artifacts (diff, prompts, answers, the seam model). Always
// cleaned up — the engine is stateless, so nothing here outlives the call. Async-aware: it AWAITS the
// callback before deleting, so the dir survives the sampling round-trips (which only resolve later).
export async function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "seam-mcp-"));
  try { return await fn(dir); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text, "utf-8");
}
