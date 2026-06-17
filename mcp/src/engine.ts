// Thin adapter over the stateless Seam engine. The MCP server NEVER reimplements decomposition —
// it locates the same CLI/binary every other client uses and consumes the --emit-seams JSON
// contract (docs/SEAM_JSON_CONTRACT.md). No daemon, no resident state: one subprocess per call.
import { spawnSync } from "node:child_process";
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

// Locate the engine, preferring the self-contained binary so a packaged MCP server needs no
// checkout: $SEAM_BIN → ts/dist/seam (bun build --compile) → bun + the source CLI.
export function engineInvocation(): { cmd: string; pre: string[] } {
  const envBin = process.env.SEAM_BIN;
  if (envBin && existsSync(envBin) && statSync(envBin).isFile()) return { cmd: envBin, pre: [] };
  const compiled = join(REPO_ROOT, "ts", "dist", "seam");
  if (existsSync(compiled)) return { cmd: compiled, pre: [] };
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
  const { cmd, pre } = engineInvocation();
  const proc = spawnSync(cmd, [...pre, "--check-backend"], { cwd, encoding: "utf-8", maxBuffer: 1 << 20 });
  _backendKind = proc.status === 0 ? (proc.stdout || "").trim() || "unknown" : null;
  return _backendKind;
}

// Run the engine with FLAGS (everything after the entry). Returns captured stdout — the engine writes
// its artifacts to the --emit-* files the caller passes, and a one-line status to stdout/stderr.
export function runEngine(flags: string[], cwd = REPO_ROOT): { stdout: string; stderr: string } {
  const { cmd, pre } = engineInvocation();
  const proc = spawnSync(cmd, [...pre, ...flags], { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (proc.error) throw new EngineError(`could not run the Seam engine (${cmd}): ${proc.error.message}`);
  if (proc.status !== 0)
    throw new EngineError(`Seam engine failed (exit ${proc.status}): ${(proc.stderr || proc.stdout || "").trim().slice(0, 600)}`);
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
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
