// Port of src/core/llm.py — shared LLM/CLI plumbing: backend resolution, the subprocess call,
// the host-bus (emit-prompts/inject-llm), JSON-array extraction, retry, usage metering. Zero
// mode knowledge. The CLI subprocess backend is what lets the TS port be byte-verified against
// Python via the host-bus contract (the same prompt both phases rebuild).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { timingOn, verbose } from "./progress.js";

export class ClassifierError extends Error {}
export const LLMError = ClassifierError;

// LLM PASS REGISTRY — the single source of truth for "what LLM passes exist and which need a strong
// model". Each pass is DECLARED next to its call site via registerPass(); core holds no hardcoded list
// of feature tags. The registry is enumerable (allPasses) so the engine can introspect its own LLM
// surface (e.g. `--list-passes`) instead of being grep-only, and `tier` lives WITH the pass so adding a
// pass can't silently forget to route it (the old failure mode of a separate STRONG_PASSES set kept in
// sync by hand). registerPass returns the spec, so call sites reference `SPEC.tag` — usage is tied to
// registration: you cannot name a pass without first declaring it.
//
// Why `strong` exists at all: a few passes are genuinely SEMANTIC judgements (which entry point / anchor
// the question is about; which key/carrier a file produces) where a weak model wobbles run-to-run — the
// stability harness pinned this as the dominant auto-grow instability (anchor flips 1/3 of runs on haiku;
// sonnet is 3/3). Cheap patches (a deterministic culmination floor, self-consistency voting) did NOT fix
// it — the variance is model-JUDGEMENT quality, not jitter a vote averages out. The carrier/key SYNTHESIS
// passes are semantic too and LEARN-ONCE (cached to .seam), so paying the strong tier once for a reliable
// adapter is worth it. Everything else (expand, orchestrate, reconcile, cluster, role, wire…) stays cheap.
export type PassTier = "cheap" | "strong";
export interface PassSpec { tag: string; tier: PassTier; note?: string; }
const _PASS_REGISTRY = new Map<string, PassSpec>();
export function registerPass(spec: PassSpec): PassSpec {
  const prev = _PASS_REGISTRY.get(spec.tag);
  if (prev && prev.tier !== spec.tier)
    throw new ClassifierError(`pass "${spec.tag}" re-registered with a conflicting tier (${prev.tier} vs ${spec.tier})`);
  _PASS_REGISTRY.set(spec.tag, spec);
  return spec;
}
export function getPass(tag: string): PassSpec | undefined { return _PASS_REGISTRY.get(tag); }
export function allPasses(): PassSpec[] { return [..._PASS_REGISTRY.values()].sort((a, b) => a.tag.localeCompare(b.tag)); }

// Upgrade-only model routing: a `strong` pass on a haiku base is lifted to STRONG_MODEL; a sonnet/opus
// base is left as-is (never downgraded), and a `cheap`/unregistered tag is untouched. Applied at the
// single runPassRaw choke point, so it covers every path (codebase run_pass AND diff runPassRaw) and is
// idempotent (re-routing an already-strong model is a no-op). The routed `model` flows to BOTH the live
// `claude --model` call AND the host-bus recorded metadata the skill routes on, so both get the tier.
// Escape hatch: SEAM_STRONG_MODEL="" disables it (so the harness can A/B a pure-base run); set it to a
// model id to pin a different strong tier.
const STRONG_MODEL = process.env.SEAM_STRONG_MODEL ?? "claude-sonnet-4-6";
function _route_model(tag: string | undefined, base: string): string {
  const spec = tag ? _PASS_REGISTRY.get(tag) : undefined;
  if (!spec || spec.tier !== "strong" || !STRONG_MODEL) return base;
  return /haiku/i.test(base) ? STRONG_MODEL : base;   // upgrade a weak base; never downgrade a strong one
}

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

// An INTERACTIVE host bus. Where HostBus records every pass for one later batch (emit-prompts →
// answer-all → inject-llm), this serves each pass synchronously over a filesystem channel: write a
// request, BLOCK until the host writes the answer, return it. That on-demand round-trip is what lets
// an in-the-loop feature — auto-orchestration, where step N's prompt depends on step N-1's answer —
// be driven by an MCP client's own model via sampling. run_pass is synchronous, and the child has
// nothing else to do but await this answer, so the wait is a synchronous Atomics poll.
export class InteractiveHostBus extends HostBus {
  private dir: string;
  private seq = 0;
  private waitMs: number;
  constructor(dir: string, waitMs = 300_000) { super(); this.dir = dir; this.waitMs = waitMs; mkdirSync(dir, { recursive: true }); }
  serve(tag: string, prompt: string, model: string, thinking: number | null): string {
    const n = this.seq++;
    const reqTmp = join(this.dir, `req-${n}.tmp`);
    const reqPath = join(this.dir, `req-${n}.json`);
    const respPath = join(this.dir, `resp-${n}.json`);
    writeFileSync(reqTmp, JSON.stringify({ seq: n, tag, prompt, model, thinking }));
    renameSync(reqTmp, reqPath);   // atomic publish — the host never reads a half-written request
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + this.waitMs;
    while (!existsSync(respPath)) {
      if (Date.now() > deadline) return "[]";   // host gone/stuck → degrade like an unavailable model
      Atomics.wait(sleeper, 0, 0, 50);          // block ~50ms between polls (no busy-spin)
    }
    let text = "[]";
    try { text = JSON.parse(readFileSync(respPath, "utf-8")).text ?? "[]"; } catch { /* keep [] */ }
    try { unlinkSync(reqPath); unlinkSync(respPath); } catch { /* ignore */ }
    return text;
  }
}

let _HOST_BUS: HostBus | null = null;
export function set_host_bus(bus: HostBus | null): void { _HOST_BUS = bus; }
export function get_host_bus(): HostBus | null { return _HOST_BUS; }

// --- usage meter -------------------------------------------------------------
export class UsageMeter {
  calls = 0; input_tokens = 0; output_tokens = 0; cost_usd = 0.0; duration_ms = 0;
  backends = new Set<string>();
  // Per-PASS invocation count keyed by tag (bumped once per pass, before retries — so it counts pass
  // ATTEMPTS at the choke point, independent of which backend/token metering ran). Lets a harness
  // assert "the grow-border pass fired N times" (the LLM-call metric §3) without parsing stderr.
  by_tag: Record<string, number> = {};
  bumpTag(tag: string): void { this.by_tag[tag] = (this.by_tag[tag] ?? 0) + 1; }
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
      duration_ms: this.duration_ms, backends: [...this.backends].sort(), by_tag: { ...this.by_tag } };
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
// A sync runner (spawnSync, one blocking subprocess) and its async twin (spawn, so independent passes
// can run concurrently — the diff engine overlaps the reconcile + cluster passes) differ ONLY in the
// spawn call. Everything else — argument building, JSON-envelope parsing, error wording, usage
// metering — is shared here, so a fix lands in exactly one place.
const _MAX_BUF = 256 * 1024 * 1024;
// HANG GUARD — a per-call wall-clock ceiling on the LLM subprocess. Without it a stalled backend (a hung
// `claude` CLI on a rate-limit/network stall, a wedged ollama) blocks the whole pipeline FOREVER — the pass has
// no way to fail, so a footprint just freezes (the seam-intent tiering is the usual victim). On timeout we KILL
// the child and surface a non-zero status → the parser throws a ClassifierError → the pass degrades to its
// deterministic floor, exactly as it does for any backend failure. Generous by default (the seam-intent pass is
// legitimately output-bound and slow on a big footprint); `SEAM_LLM_TIMEOUT_MS` overrides.
const _llmTimeoutMs = (): number => Math.max(100, Number(process.env.SEAM_LLM_TIMEOUT_MS) || 180000);   // read per call (env-overridable, testable)
interface ProcResult { status: number; stdout: string; stderr: string; }

function _spawnSync(bin: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): ProcResult {
  const ms = _llmTimeoutMs();
  const p = spawnSync(bin, args, { input: opts.input, encoding: "utf-8", env: opts.env ?? process.env, maxBuffer: _MAX_BUF, timeout: ms, killSignal: "SIGKILL" });
  if ((p as any).error && ((p as any).error.code === "ETIMEDOUT" || p.signal === "SIGKILL"))
    return { status: -1, stdout: p.stdout ?? "", stderr: `timed out after ${ms}ms (SEAM_LLM_TIMEOUT_MS)` };
  return { status: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function _spawnAsync(bin: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    const ms = _llmTimeoutMs();
    const proc = spawn(bin, args, { env: opts.env ?? process.env });
    let stdout = "", stderr = "", done = false;
    const finish = (r: ProcResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } finish({ status: -1, stdout, stderr: `timed out after ${ms}ms (SEAM_LLM_TIMEOUT_MS)` }); }, ms);
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => finish({ status: -1, stdout, stderr: String((e as Error).message ?? e) }));
    proc.on("close", (code) => finish({ status: code ?? -1, stdout, stderr }));
    if (opts.input != null) { proc.stdin.write(opts.input); proc.stdin.end(); }
  });
}

// claude: pure arg/env builders + envelope parse (with metering), shared by the sync runner and its twin.
function _claudeArgs(model: string): string[] { return ["-p", "--output-format", "json", "--model", model, "--strict-mcp-config"]; }
function _claudeEnv(thinking: number | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (thinking !== null) env.MAX_THINKING_TOKENS = String(thinking);
  return env;
}
function _parseClaude(p: ProcResult): string {
  if (p.status !== 0)
    throw new ClassifierError(`claude CLI failed (exit ${p.status}): ${p.stderr.trim().slice(0, 300)}`);
  let envelope: any;
  try { envelope = JSON.parse(p.stdout); }
  catch { throw new ClassifierError(`claude CLI did not return JSON: ${JSON.stringify(p.stdout.slice(0, 200))}`); }
  if (envelope.is_error) throw new ClassifierError(`claude CLI reported error: ${envelope.result}`);
  _USAGE.record("claude", envelope.usage ?? {}, envelope.total_cost_usd, envelope.duration_ms);
  return envelope.result ?? "";
}

// copilot has no `--strict-mcp-config` (claude's flag): a plain `copilot -p` boots the user's FULL MCP
// config on EVERY pass — every server reconnected per call, including Seam's OWN MCP server (a recursion
// hazard) — which is the dominant reason copilot passes run slow enough to time out an MCP grow (many
// passes × a heavy MCP cold-start each). The only lever copilot exposes is `--config-dir`, which overrides
// the whole config dir. So we point it at a scratch dir that SHADOWS mcp-config.json with `{}` (no user
// servers) while SYMLINKING the auth/settings FILES through, so login keeps working in every auth mode
// (env-token / OS-keychain / plaintext config.json all preserved — only env/keychain survive a bare
// config-dir swap, so the symlink is what saves the plaintext-token user). Session/log state lands in the
// scratch dir (directories are NOT symlinked), so our passes don't pollute the user's real copilot history.
// Best-effort: any failure → null → we omit the flag and fall back to the un-isolated call rather than risk
// breaking auth. Disable with SEAM_COPILOT_ISOLATE=0. Memoized: a process-lifetime fact.
let _copilotCfgDir: string | null | undefined;
function _copilotConfigDir(): string | null {
  if (_copilotCfgDir !== undefined) return _copilotCfgDir;
  const off = (process.env.SEAM_COPILOT_ISOLATE ?? "").trim().toLowerCase();
  if (["0", "off", "false", "no"].includes(off)) return (_copilotCfgDir = null);
  try {
    const src = process.env.COPILOT_CONFIG_DIR || join(homedir(), ".copilot");
    const iso = mkdtempSync(join(tmpdir(), "seam-copilot-cfg-"));
    try {
      for (const e of readdirSync(src, { withFileTypes: true }))
        if (e.isFile() && e.name !== "mcp-config.json") symlinkSync(join(src, e.name), join(iso, e.name));
    } catch { /* no source config dir (env-token auth / first run): the empty mcp-config alone still isolates */ }
    writeFileSync(join(iso, "mcp-config.json"), "{}");   // shadow the user's MCP servers (incl. Seam itself)
    return (_copilotCfgDir = iso);
  } catch { return (_copilotCfgDir = null); }
}

// copilot: reads the prompt from a temp file (it can exceed argv limits). args + parse are shared; only
// the spawn call differs, wrapped in the same temp-file lifecycle.
function _copilotArgs(promptPath: string, thinking: number | null): string[] {
  const pointer = `Read the file ${promptPath} and follow the instructions it contains exactly. `
    + `Output only what those instructions ask for.`;
  const cmd = ["-p", pointer, "-s", "--no-ask-user", "--allow-all-tools"];
  const cfgDir = _copilotConfigDir();
  if (cfgDir) cmd.push("--config-dir", cfgDir);   // isolate MCP config so copilot doesn't reload every server (incl. Seam) per pass
  if (process.env.COPILOT_MODEL) cmd.push("--model", process.env.COPILOT_MODEL);
  const effort = _thinking_to_effort(thinking);
  if (effort) cmd.push("--effort", effort);
  return cmd;
}
function _parseCopilot(p: ProcResult): string {
  if (p.status !== 0)
    throw new ClassifierError(`copilot CLI failed (exit ${p.status}): ${p.stderr.trim().slice(0, 300)}`);
  if (!p.stdout.trim())
    throw new ClassifierError(`copilot CLI returned no output: ${JSON.stringify(p.stderr.trim().slice(0, 200))}`);
  return p.stdout;
}
function _copilotPromptPath(prompt: string): string {
  const promptPath = join(mkdtempSync(join(tmpdir(), "copilot-prompt-")), "prompt.txt");
  writeFileSync(promptPath, prompt, "utf-8");
  return promptPath;
}

function _run_claude(bin: string, prompt: string, model: string, thinking: number | null): string {
  return _parseClaude(_spawnSync(bin, _claudeArgs(model), { input: prompt, env: _claudeEnv(thinking) }));
}
async function _run_claude_async(bin: string, prompt: string, model: string, thinking: number | null): Promise<string> {
  return _parseClaude(await _spawnAsync(bin, _claudeArgs(model), { input: prompt, env: _claudeEnv(thinking) }));
}
function _run_copilot(bin: string, prompt: string, thinking: number | null): string {
  const promptPath = _copilotPromptPath(prompt);
  try { return _parseCopilot(_spawnSync(bin, _copilotArgs(promptPath, thinking))); }
  finally { try { unlinkSync(promptPath); } catch { /* ignore */ } }
}
async function _run_copilot_async(bin: string, prompt: string, thinking: number | null): Promise<string> {
  const promptPath = _copilotPromptPath(prompt);
  try { return _parseCopilot(await _spawnAsync(bin, _copilotArgs(promptPath, thinking))); }
  finally { try { unlinkSync(promptPath); } catch { /* ignore */ } }
}

function _run_backend(kind: string, binary: string, prompt: string, model: string, thinking: number | null): string {
  return kind === "claude" ? _run_claude(binary, prompt, model, thinking) : _run_copilot(binary, prompt, thinking);
}
async function _run_backend_async(kind: string, binary: string, prompt: string, model: string, thinking: number | null): Promise<string> {
  return kind === "claude" ? _run_claude_async(binary, prompt, model, thinking) : _run_copilot_async(binary, prompt, thinking);
}

// --- Ollama backend: a LOCAL fast SLM for the CHEAP tier (opt-in) --------------------------------------
// The `claude -p` subprocess has a ~15s/call FLOOR even on haiku for a 2 KB prompt; a tight cheap-tier
// classification (the grow-border keep/drop judge — "structure proposes candidates, the model judges which
// are on-intent") is exactly the small, specific reasoning a local 3B model answers in <1s. Routing the
// cheap tier to Ollama turns a reliable-but-slow LLM grow (~75s) into reliable-AND-fast (~5s).
//   • OPT-IN: SEAM_OLLAMA_MODEL=<model> (e.g. qwen2.5:3b). Unset → Ollama OFF, ZERO behaviour change.
//   • CHEAP TIER ONLY: a `strong` pass (anchoring judge, key discovery) NEVER uses it — it needs the capable model.
//   • DEGRADES: unset / server unreachable / model missing / a failed call → falls back to claude, so it only
//     ever makes the cheap tier FASTER, never changes what's reachable.
// HTTP via `curl` (one mechanism for sync + async, like the engine's other subprocess backends; no fetch so
// it works identically under bun and the esbuilt .vsix). curl absent → probe fails → claude.
// Env-only (the library reads no files): the COMPOSITION ROOT (CLI main / MCP server) applies the provisioned
// `~/.seam/slm.json` to these env vars at startup via applySlmConfigToEnv(), so tests + library callers that
// don't set them get the default (Ollama OFF) and never see a host's config.
const _ollamaUrl = (): string => process.env.SEAM_OLLAMA_URL ?? "http://127.0.0.1:11434";
const _ollamaModel = (): string => process.env.SEAM_OLLAMA_MODEL ?? "";   // empty ⇒ Ollama disabled
const _ollamaTimeoutS = (): string => String(Math.max(2, Math.ceil(Number(process.env.SEAM_OLLAMA_TIMEOUT ?? 120000) / 1000)));
let _ollamaOk: boolean | null = null;
export function _resetOllamaProbe(): void { _ollamaOk = null; }   // tests toggle the env between cases
const _sleep = (ms: number): void => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → skip */ } };
function _probeOllama(): boolean {   // server reachable AND the model is pulled (so a generate call will work)
  const r = _spawnSync("curl", ["-sf", "-m", "2", `${_ollamaUrl()}/api/tags`]);
  return r.status === 0 && r.stdout.includes(_ollamaModel().split(":")[0]);
}
// Auto-start the MANAGED ollama binary (recorded in slm.json by the provisioner) when the server isn't up —
// so a provisioned SLM "just works" after a reboot without the user re-running `ollama serve`. Best-effort:
// spawn detached, wait ~6s for the PORT (not the model load), degrade to claude if it never comes up.
function _ensureManagedServer(): void {
  const bin = process.env.SEAM_OLLAMA_BIN;   // set from slm.json by the composition root; absent ⇒ reuse a server the user runs
  if (!bin || !existsSync(bin)) return;
  try {
    const host = _ollamaUrl().replace(/^https?:\/\//, "");
    spawn(bin, ["serve"], { detached: true, stdio: "ignore", env: { ...process.env, OLLAMA_HOST: host } }).unref();
    for (const deadline = Date.now() + 6000; Date.now() < deadline; _sleep(300))
      if (_spawnSync("curl", ["-sf", "-m", "1", `${_ollamaUrl()}/api/tags`]).status === 0) return;
  } catch { /* best-effort */ }
}
function _ollamaAvailable(): boolean {
  const model = _ollamaModel();
  if (!model || _HOST_BUS !== null) return false;   // host-bus (MCP sampling) owns the model
  if (_ollamaOk !== null) return _ollamaOk;
  if (_probeOllama()) return (_ollamaOk = true);
  _ensureManagedServer();                            // not up → try to start the provisioned binary, then re-probe
  return (_ollamaOk = _probeOllama());
}
// route a CHEAP-tier pass to Ollama (strong tier and unregistered tags stay on claude/copilot)
export function _cheapViaOllama(tag: string | undefined): boolean {
  const spec = tag ? _PASS_REGISTRY.get(tag) : undefined;
  return !!spec && spec.tier === "cheap" && _ollamaAvailable();
}
// A FAST local cheap-tier backend is configured + reachable (Ollama). The grow uses this to decide its
// DEFAULT picker: a fast SLM makes the reliable wave+LLM-border grow also fast (~45s vs ~75s on claude's
// per-call floor), so it's worth defaulting ON; without it, the grow stays on the instant deterministic
// picker. Cached probe; false under the host bus (MCP owns the model).
export function fastCheapBackend(): boolean { return _ollamaAvailable(); }
const _ollamaArgs = (): string[] => ["-sf", "-m", _ollamaTimeoutS(), "-X", "POST", `${_ollamaUrl()}/api/generate`,
  "-H", "content-type: application/json", "-d", "@-"];   // body (model+prompt) on stdin → no argv limit
const _ollamaBody = (prompt: string): string => JSON.stringify({ model: _ollamaModel(), prompt, stream: false, options: { temperature: 0 } });
function _parseOllama(p: ProcResult): string {
  if (p.status !== 0) throw new ClassifierError(`ollama call failed (exit ${p.status}): ${p.stderr.trim().slice(0, 200)}`);
  let j: any; try { j = JSON.parse(p.stdout); } catch { throw new ClassifierError(`ollama did not return JSON: ${JSON.stringify(p.stdout.slice(0, 200))}`); }
  if (j.error) throw new ClassifierError(`ollama error: ${j.error}`);
  _USAGE.record("ollama", { input_tokens: j.prompt_eval_count ?? 0, output_tokens: j.eval_count ?? 0 }, 0, (j.total_duration ?? 0) / 1e6);
  return String(j.response ?? "");
}
function _run_ollama(prompt: string): string { return _parseOllama(_spawnSync("curl", _ollamaArgs(), { input: _ollamaBody(prompt) })); }
async function _run_ollama_async(prompt: string): Promise<string> { return _parseOllama(await _spawnAsync("curl", _ollamaArgs(), { input: _ollamaBody(prompt) })); }

// Serve ONE pass, picking the backend: host bus (MCP sampling) → Ollama (cheap tier, when up) → claude/copilot.
// An Ollama hiccup falls back to claude so the cheap pass still answers (never lost to a flaky local server).
// Returns the reply AND the model actually used (so timing/metering name the real backend).
function _serve(kind: string, binary: string, prompt: string, model: string, thinking: number | null, tag: string): { raw: string; model: string } {
  if (_HOST_BUS !== null) return { raw: _HOST_BUS.serve(tag, prompt, model, thinking), model };
  if (_cheapViaOllama(tag)) { try { return { raw: _run_ollama(prompt), model: `ollama:${_ollamaModel()}` }; } catch { /* local server hiccup → claude */ } }
  return { raw: _run_backend(kind, binary, prompt, model, thinking), model };
}
async function _serveAsync(kind: string, binary: string, prompt: string, model: string, thinking: number | null, tag: string): Promise<{ raw: string; model: string }> {
  if (_HOST_BUS !== null) return { raw: _HOST_BUS.serve(tag, prompt, model, thinking), model };
  if (_cheapViaOllama(tag)) { try { return { raw: await _run_ollama_async(prompt), model: `ollama:${_ollamaModel()}` }; } catch { /* local server hiccup → claude */ } }
  return { raw: await _run_backend_async(kind, binary, prompt, model, thinking), model };
}

// The model a pass will ACTUALLY run on, for the at-call-time log — Ollama (cheap tier, when up) shows as
// `ollama:<model>` rather than the routed claude/haiku. (A rare Ollama hiccup still falls back to claude at
// serve time; the [timing] line names the real backend either way, so the two logs agree in the normal case.)
function _effectiveModel(tag: string, routed: string): string {
  return _HOST_BUS === null && _cheapViaOllama(tag) ? `ollama:${_ollamaModel()}` : routed;
}

// JSON reply → {id: item} map; per-pass timing emit. Both shared by the two pass runners below.
function _collect(raw: string, labels: Map<string, any>): void {
  for (const item of extractJsonArray(raw))
    if (item && typeof item === "object" && "id" in item) labels.set(String(item.id), item);
}
function _emitTiming(t0: number, tag: string, model: string, promptLen: number): void {
  if (t0) process.stderr.write(`[timing] LLM ${tag} (${model}): ${Math.round(performance.now() - t0)}ms, prompt ${promptLen} chars\n`);
}

// Log EVERY LLM pass at the moment it's called, with the data injected into its prompt. At --verbose: a line
// per call (#seq, tag, model, prompt size). Set SEAM_LLM_DUMP=<dir> to also write each pass's FULL prompt to
// `<dir>/NNN-<tag>.txt` — so you can read exactly what each pass was asked (debugging + granularity tuning).
let _passSeq = 0;
function _logPass(tag: string, model: string, prompt: string): void {
  const seq = ++_passSeq;
  _USAGE.bumpTag(tag);   // per-tag pass-invocation count (the §3 LLM-call metric), independent of backend metering
  const dir = process.env.SEAM_LLM_DUMP;
  if (verbose() || dir) process.stderr.write(`[llm] #${seq} ${tag} (${model}) ← ${prompt.length} chars${dir ? ` → ${tag}` : ""}\n`);
  if (dir) {
    try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${String(seq).padStart(3, "0")}-${tag}.txt`), `# pass #${seq}: ${tag}\n# model: ${model}\n# prompt: ${prompt.length} chars\n\n${prompt}`); }
    catch { /* best-effort dump */ }
  }
}

// Run ONE LLM pass (with one retry on malformed JSON) → {id: item}. Serves the host bus when set.
export function runPassRaw(kind: string, binary: string, prompt: string, model: string,
                           thinking: number | null, tag: string): Map<string, any> {
  model = _route_model(tag, model);   // strong-tier upgrade, sourced from the pass registry
  const labels = new Map<string, any>();
  let lastErr: Error | null = null;
  const t0 = (verbose() || timingOn()) ? performance.now() : 0;   // per-pass wall-clock — LLM cost is important at --verbose
  _logPass(tag, _effectiveModel(tag, model), prompt);
  for (const _attempt of [1, 2]) {
    try {
      const { raw, model: used } = _serve(kind, binary, prompt, model, thinking, tag);
      _emitTiming(t0, tag, used, prompt.length);
      _collect(raw, labels);
      break;
    } catch (e) { lastErr = e as Error; }
  }
  if (!labels.size && lastErr) throw new ClassifierError(`${tag} pass failed after retry: ${lastErr.message}`);
  return labels;
}

// Async twin of runPassRaw — identical retry/parse/metering, but awaits a non-blocking subprocess so
// callers can run independent passes concurrently (Promise.all). The host-bus path serves synchronously
// (batch HostBus returns from its answers map immediately), so it composes trivially.
export async function runPassRawAsync(kind: string, binary: string, prompt: string, model: string,
                                     thinking: number | null, tag: string): Promise<Map<string, any>> {
  model = _route_model(tag, model);   // strong-tier upgrade, sourced from the pass registry
  const labels = new Map<string, any>();
  let lastErr: Error | null = null;
  const t0 = (verbose() || timingOn()) ? performance.now() : 0;   // per-pass wall-clock — LLM cost is important at --verbose
  _logPass(tag, _effectiveModel(tag, model), prompt);
  for (const _attempt of [1, 2]) {
    try {
      const { raw, model: used } = await _serveAsync(kind, binary, prompt, model, thinking, tag);
      _emitTiming(t0, tag, used, prompt.length);
      _collect(raw, labels);
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
  // tier routing happens in runPassRaw (the single choke point), keyed on tag via the registry
  return runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", opts.thinking ?? 0, opts.tag ?? "codebase");
}

// Async twin of run_pass — awaits a non-blocking subprocess so INDEPENDENT passes can run concurrently
// (Promise.all) on the direct `claude -p` path. The host-bus path still serves sequentially (its serve is
// sync), so the skill/MCP stay correct — they just don't overlap.
export async function run_pass_async(prompt: string, opts: {
  model?: string; tag?: string; thinking?: number | null; claudeBin?: string | null;
} = {}): Promise<Map<string, any>> {
  const [kind, binary] = resolve_backend(opts.claudeBin);
  // tier routing happens in runPassRawAsync (the single choke point), keyed on tag via the registry
  return runPassRawAsync(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", opts.thinking ?? 0, opts.tag ?? "codebase");
}
