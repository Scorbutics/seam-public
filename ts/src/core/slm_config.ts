// PROVISIONED LOCAL-SLM CONFIG — written by `seam slm install`, read by the engine so a fast local model
// serves the cheap tier (the grow-border judge) WITHOUT the user exporting SEAM_OLLAMA_MODEL. The provisioner
// installs/locates an Ollama-compatible server, pulls a small model, and records it here; llm.ts then routes
// cheap-tier passes to it (and auto-starts the managed binary when the server isn't up). Env vars
// (SEAM_OLLAMA_MODEL / SEAM_OLLAMA_URL) still WIN over this file — it's the zero-config default, not an override.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface SlmConfig {
  model: string;          // e.g. "qwen2.5:3b"
  url: string;            // e.g. "http://127.0.0.1:11434"
  bin?: string | null;    // managed ollama binary to AUTO-START when the server is down; null/absent ⇒ reuse a server the user runs
}

export function slmConfigPath(): string { return process.env.SEAM_SLM_CONFIG ?? join(homedir(), ".seam", "slm.json"); }

// Memoised: the provisioner runs in a SEPARATE process, so within one engine run the file is stable. A read
// per cheap-pass routing decision would otherwise hit the disk on every LLM call. resetSlmConfig() for tests.
let _cache: SlmConfig | null | undefined;
export function readSlmConfig(): SlmConfig | null {
  if (_cache !== undefined) return _cache;
  try {
    const p = slmConfigPath();
    if (!existsSync(p)) return (_cache = null);
    const c = JSON.parse(readFileSync(p, "utf-8"));
    _cache = (c && typeof c.model === "string" && c.model && typeof c.url === "string" && c.url) ? c : null;
  } catch { _cache = null; }
  return _cache ?? null;
}
export function writeSlmConfig(cfg: SlmConfig): void {
  const p = slmConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  _cache = cfg;
}
export function resetSlmConfig(): void { _cache = undefined; }

// Apply the provisioned config to the env the engine reads — called ONCE by the composition root (CLI main /
// MCP server), NOT by the library. Env always WINS (an explicit SEAM_OLLAMA_* is never overridden), so this is
// purely the zero-config default. Keeping the read here (not in llm.ts) means library callers + tests that
// don't set these env vars get Ollama OFF and never pick up a host's slm.json.
export function applySlmConfigToEnv(): void {
  const cfg = readSlmConfig();
  if (!cfg) return;
  if (process.env.SEAM_OLLAMA_MODEL === undefined) process.env.SEAM_OLLAMA_MODEL = cfg.model;
  if (process.env.SEAM_OLLAMA_URL === undefined) process.env.SEAM_OLLAMA_URL = cfg.url;
  if (cfg.bin && process.env.SEAM_OLLAMA_BIN === undefined) process.env.SEAM_OLLAMA_BIN = cfg.bin;
}
