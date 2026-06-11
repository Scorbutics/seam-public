// Port of src/core/llm.py — shared LLM/CLI plumbing: backend resolution, the subprocess call,
// the host-bus (emit-prompts/inject-llm), JSON-array extraction, retry, usage metering. Zero
// mode knowledge. The CLI subprocess backend is what lets the TS port be byte-verified against
// Python via the host-bus contract (the same prompt both phases rebuild).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export class ClassifierError extends Error {}
export const LLMError = ClassifierError;

const _VSCODE_EXT_GLOB_PREFIX = "anthropic.claude-code-";
const _VSCODE_EXT_BIN_SUFFIX = join("resources", "native-binary", "claude");

// --- thinking → copilot effort ----------------------------------------------
function _thinking_to_effort(thinking: number | null): string | null {
  const override = process.env.COPILOT_EFFORT;
  if (override !== undefined) {
    const level = override.trim().toLowerCase();
    return ["off", "none", ""].includes(level) ? null : level;
  }
  if (thinking === null) return "high";
  if (thinking === 0) return "low";
  return "medium";
}

// --- host bus (the emit-prompts / inject-llm contract) ----------------------
export interface RecordedPass { prompt: string; model: string; thinking: number | null; }

export class HostBus {
  answers: Record<string, string>;
  recorded: Map<string, RecordedPass> = new Map(); // insertion order preserved
  constructor(answers?: Record<string, string>) { this.answers = { ...(answers ?? {}) }; }
  serve(tag: string, prompt: string, model: string, thinking: number | null): string {
    this.recorded.set(tag, { prompt, model, thinking });
    return this.answers[tag] ?? "[]";
  }
}

let _HOST_BUS: HostBus | null = null;
export function set_host_bus(bus: HostBus | null): void { _HOST_BUS = bus; }
export function get_host_bus(): HostBus | null { return _HOST_BUS; }

// --- usage meter -------------------------------------------------------------
export class UsageMeter {
  calls = 0; input_tokens = 0; output_tokens = 0; cost_usd = 0.0; duration_ms = 0;
  backends = new Set<string>();
  record(kind: string, usage: any, cost_usd: any, duration_ms: any): void {
    this.calls += 1;
    this.backends.add(kind);
    this.input_tokens += (Number(usage.input_tokens || 0)
      + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0));
    this.output_tokens += Number(usage.output_tokens || 0);
    this.cost_usd += Number(cost_usd || 0.0);
    this.duration_ms += Number(duration_ms || 0);
  }
  get total_tokens(): number { return this.input_tokens + this.output_tokens; }
  as_dict(): any | null {
    if (!this.calls) return null;
    return { calls: this.calls, input_tokens: this.input_tokens, output_tokens: this.output_tokens,
      total_tokens: this.total_tokens, cost_usd: Math.round(this.cost_usd * 1e4) / 1e4,
      duration_ms: this.duration_ms, backends: [...this.backends].sort() };
  }
  summary(): string {
    if (!this.calls) return "";
    const parts = [`${this.calls} LLM call${this.calls !== 1 ? "s" : ""}`];
    if (this.total_tokens) parts.push(`${(this.total_tokens / 1000).toFixed(1)}k tokens `
      + `(in ${(this.input_tokens / 1000).toFixed(1)}k / out ${(this.output_tokens / 1000).toFixed(1)}k)`);
    if (this.cost_usd) parts.push(`$${this.cost_usd.toFixed(4)}`);
    if (this.duration_ms) parts.push(`${Math.round(this.duration_ms / 1000)}s`);
    return parts.join(" · ");
  }
}
let _USAGE = new UsageMeter();
export function reset_usage(): void { _USAGE = new UsageMeter(); }
export function get_usage(): UsageMeter { return _USAGE; }

// --- backend location --------------------------------------------------------
function which(bin: string): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf-8" });
  const out = (r.stdout ?? "").split("\n")[0].trim();
  return r.status === 0 && out ? out : null;
}

function _locate_claude(): string | null {
  const env = process.env.CLAUDE_BIN;
  if (env && existsSync(env) && statSync(env).isFile()) return env;
  const onPath = which("claude");
  if (onPath) return onPath;
  const extDir = join(homedir(), ".vscode", "extensions");
  if (!existsSync(extDir)) return null;
  const matches = readdirSync(extDir)
    .filter((d) => d.startsWith(_VSCODE_EXT_GLOB_PREFIX))
    .map((d) => join(extDir, d, _VSCODE_EXT_BIN_SUFFIX))
    .filter((p) => existsSync(p))
    .sort();
  return matches.length ? matches[matches.length - 1] : null;
}

function _locate_copilot(): string | null {
  const env = process.env.COPILOT_BIN;
  if (env && existsSync(env) && statSync(env).isFile()) return env;
  return which("copilot");
}

export function resolve_backend(claudeOverride?: string | null): [string, string] {
  if (_HOST_BUS !== null) return ["host", ""];
  if (claudeOverride) {
    if (existsSync(claudeOverride) && statSync(claudeOverride).isFile()) return ["claude", claudeOverride];
    throw new ClassifierError(`--claude-bin not found: ${claudeOverride}`);
  }
  const claude = _locate_claude();
  if (claude) return ["claude", claude];
  const copilot = _locate_copilot();
  if (copilot) return ["copilot", copilot];
  throw new ClassifierError(
    "Could not find an LLM CLI. Install the `claude` CLI (Claude Code subscription) or the "
    + "GitHub `copilot` CLI, put one on PATH, or set CLAUDE_BIN / COPILOT_BIN.");
}

// --- JSON-array extraction ---------------------------------------------------
export function extractJsonArray(text: string): any[] {
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  }
  try { const v = JSON.parse(text); if (Array.isArray(v)) return v; } catch { /* fall through */ }
  for (const pat of [/\[[\s\S]*\]/g, /\[[\s\S]*?\]/g]) {
    const matches = [...text.matchAll(pat)].map((m) => m[0]).sort((a, b) => b.length - a.length);
    for (const m of matches) {
      try { const v = JSON.parse(m); if (Array.isArray(v)) return v; } catch { /* next */ }
    }
  }
  throw new ClassifierError(`No JSON array in model reply: ${JSON.stringify(text.slice(0, 200))}`);
}

// --- backend run -------------------------------------------------------------
function _run_claude(claudeBin: string, prompt: string, model: string, thinking: number | null): string {
  const cmd = ["-p", "--output-format", "json", "--model", model, "--strict-mcp-config"];
  const env = { ...process.env };
  if (thinking !== null) env.MAX_THINKING_TOKENS = String(thinking);
  const proc = spawnSync(claudeBin, cmd, { input: prompt, encoding: "utf-8", env, maxBuffer: 256 * 1024 * 1024 });
  if (proc.status !== 0)
    throw new ClassifierError(`claude CLI failed (exit ${proc.status}): ${(proc.stderr ?? "").trim().slice(0, 300)}`);
  let envelope: any;
  try { envelope = JSON.parse(proc.stdout); }
  catch { throw new ClassifierError(`claude CLI did not return JSON: ${JSON.stringify((proc.stdout ?? "").slice(0, 200))}`); }
  if (envelope.is_error) throw new ClassifierError(`claude CLI reported error: ${envelope.result}`);
  _USAGE.record("claude", envelope.usage ?? {}, envelope.total_cost_usd, envelope.duration_ms);
  return envelope.result ?? "";
}

function _run_copilot(copilotBin: string, prompt: string, thinking: number | null): string {
  const dir = mkdtempSync(join(tmpdir(), "copilot-prompt-"));
  const promptPath = join(dir, "prompt.txt");
  try {
    writeFileSync(promptPath, prompt, "utf-8");
    const pointer = `Read the file ${promptPath} and follow the instructions it contains exactly. `
      + `Output only what those instructions ask for.`;
    const cmd = ["-p", pointer, "-s", "--no-ask-user", "--allow-all-tools"];
    if (process.env.COPILOT_MODEL) cmd.push("--model", process.env.COPILOT_MODEL);
    const effort = _thinking_to_effort(thinking);
    if (effort) cmd.push("--effort", effort);
    const proc = spawnSync(copilotBin, cmd, { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
    if (proc.status !== 0)
      throw new ClassifierError(`copilot CLI failed (exit ${proc.status}): ${(proc.stderr ?? "").trim().slice(0, 300)}`);
    if (!(proc.stdout ?? "").trim())
      throw new ClassifierError(`copilot CLI returned no output: ${JSON.stringify((proc.stderr ?? "").trim().slice(0, 200))}`);
    return proc.stdout;
  } finally {
    try { unlinkSync(promptPath); } catch { /* ignore */ }
  }
}

function _run_backend(kind: string, binary: string, prompt: string, model: string, thinking: number | null): string {
  return kind === "claude" ? _run_claude(binary, prompt, model, thinking) : _run_copilot(binary, prompt, thinking);
}

// Run ONE LLM pass (with one retry on malformed JSON) → {id: item}. Serves the host bus when set.
export function runPassRaw(kind: string, binary: string, prompt: string, model: string,
                           thinking: number | null, tag: string): Map<string, any> {
  const labels = new Map<string, any>();
  let lastErr: Error | null = null;
  for (const attempt of [1, 2]) {
    try {
      const raw = _HOST_BUS !== null
        ? _HOST_BUS.serve(tag, prompt, model, thinking)
        : _run_backend(kind, binary, prompt, model, thinking);
      for (const item of extractJsonArray(raw))
        if (item && typeof item === "object" && "id" in item) labels.set(String(item.id), item);
      break;
    } catch (e) { lastErr = e as Error; }
  }
  if (!labels.size && lastErr) throw new ClassifierError(`${tag} pass failed after retry: ${lastErr.message}`);
  return labels;
}

export function available(claudeBin?: string | null): boolean {
  try { resolve_backend(claudeBin); return true; } catch { return false; }
}

export function run_pass(prompt: string, opts: {
  model?: string; tag?: string; thinking?: number | null; claudeBin?: string | null;
} = {}): Map<string, any> {
  const [kind, binary] = resolve_backend(opts.claudeBin);
  return runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5",
    opts.thinking ?? 0, opts.tag ?? "codebase");
}
