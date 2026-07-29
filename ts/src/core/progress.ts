// Port of src/core/progress.py — phase-progress side-channel. A one-line, machine-parseable marker
// on STDERR (stdout carries the --emit-seams / report payload). The VS Code host strips PREFIX and
// shows `message` verbatim. Markers are unconditional (not gated on --verbose); the host needs them.
export const PREFIX = "@@SEAM_PROGRESS@@";
// A final machine-parseable timing summary, emitted once at the end of a run, so a client (MCP / the
// skill) can tell the user how long each phase took. Separate marker so the per-phase PREFIX lines stay
// byte-identical (no UX/test change). Carries every emit()'d phase with its delta + cumulative time.
export const TIMING_PREFIX = "@@SEAM_TIMING@@";

// USER-FACING DIAGNOSTICS SWITCH. The `--verbose` CLI flag sets SEAM_VERBOSE=1; every "explain what
// happened" site (coupling-debug, anchor-debug, sub-step timing) consults this single predicate, so the
// user has ONE flag instead of N undocumented env vars. The granular SEAM_*_DEBUG / SEAM_TIMING vars
// still work as dev-only narrow toggles (e.g. coupling-debug WITHOUT the timing firehose). The engine is
// threaded over `process` for these cross-cutting stderr channels (as PROGRESS/TIMING already are), so a
// flag → env hand-off keeps the diagnostic sites loose-coupled (no opts threading through every layer).
// THREE diagnostic levels, so the firehose stops drowning the signal:
//   default    — phase PROGRESS markers only (emit() below); what a normal run / the extension shows
//   --verbose  — + one IMPORTANT debug line per grow STEP and per coupling STAGE (dbg() below): the
//                "what did each step decide, and why" view you read to DEBUG a footprint
//   --trace    — + the per-NODE timing firehose (build-timing/dep-pass/dc-timing): a dev deep-dive
export const verbose = (): boolean => process.env.SEAM_VERBOSE === "1";
export const timingOn = (): boolean => !!process.env.SEAM_TIMING;   // the --trace per-node firehose ONLY (no longer fired by --verbose)
// Important, human-readable debug — one line per grow step / coupling stage, at --verbose. NOT the
// @@PROGRESS@@ marker the extension parses, and NOT the per-node timing firehose (that is --trace).
export function dbg(message: string): void { if (verbose()) process.stderr.write(`${message}\n`); }

// QUIET MODE — when an LLM/agent consumes the stdout render (`--format agent`/`llm-context`/`concern`/…), the
// stderr progress markers (@@SEAM_PROGRESS@@) and the `[tag]` diagnostics are NOISE: the shell interleaves them
// into what the agent reads. installQuietFilter() drops exactly those lines — the diagnostic CONVENTION (a
// @@SEAM…@@ marker, or a leading `[lower-tag]`) — while letting genuine errors/warnings through. ONE choke point
// instead of gating 50+ scattered `process.stderr.write("[…]")` sites. `--verbose` (and the --emit-seams /
// --llm-bridge extension paths) never install it, so the extension still gets its progress markers. emit() still
// runs (timing is recorded); only the visible line is suppressed.
let _quiet = false;
export function quiet(): boolean { return _quiet; }
// The stderr write captured BEFORE the quiet filter replaced it — `warn()` uses this so a degradation
// notice cannot be swallowed by the filter that exists to hide progress chatter.
let _rawErr: ((s: string) => void) | null = null;

/// A DEGRADED OR TRUNCATED ANSWER — always shown, quiet filter or not.
///
/// The filter drops every `[tag] ` line so a plain-CLI reader gets only the map. That is right for progress
/// chatter and wrong for "your answer is smaller than you asked for" or "this ran without the model": those
/// are the difference between an answer and a partial answer, and a user who cannot see them cannot tell
/// which one they got. Silent degradation is the exact failure this engine refuses everywhere else — it
/// should not be reintroduced by a display filter.
export function warn(msg: string): void {
  const line = msg.endsWith("\n") ? msg : msg + "\n";
  if (_rawErr) _rawErr(line);
  else process.stderr.write(line);
}

export function installQuietFilter(): void {
  if (_quiet) return;
  _quiet = true;
  const orig = process.stderr.write.bind(process.stderr);
  _rawErr = (s: string) => { (orig as any)(s); };
  const isDiag = (s: string): boolean => s.startsWith(PREFIX) || s.startsWith(TIMING_PREFIX) || /^\[[a-z][\w-]*\] /.test(s);
  (process.stderr.write as any) = (chunk: any, ...rest: any[]): boolean =>
    (typeof chunk === "string" && isDiag(chunk)) ? true : (orig as any)(chunk, ...rest);
}

// An emit() marks a phase's START; its duration is measured FORWARD (until the next phase begins, or
// the run ends). This is what lets the dominant cost show up correctly even when it's the LAST phase
// (e.g. the seam-intent LLM pass: its emit fires, then the slow call runs, then the run ends).
type Phase = { phase: string; atMs: number };
let _t0: number | null = null;
const _phases: Phase[] = [];

export function emit(message: string): void {
  const now = performance.now();
  if (_t0 === null) _t0 = now;
  _phases.push({ phase: message, atMs: Math.round(now - _t0) });
  process.stderr.write(`${PREFIX} ${message}\n`);
}

// Emit the timing summary marker (no-op if nothing was timed). Call once when a run finishes. Each phase
// carries `durationMs` = how long that step took (start → next phase / end of run) + `atMs` (offset).
export function emitTimingSummary(): void {
  if (_t0 === null || !_phases.length) return;
  const totalMs = Math.round(performance.now() - _t0);
  const phases = _phases.map((p, i) => ({
    phase: p.phase, atMs: p.atMs,
    durationMs: (i + 1 < _phases.length ? _phases[i + 1].atMs : totalMs) - p.atMs,
  }));
  process.stderr.write(`${TIMING_PREFIX} ${JSON.stringify({ totalMs, phases })}\n`);
}

export function resetTimings(): void { _t0 = null; _phases.length = 0; }

// STAGE SUMMARY (SEAM_TIMING) — coarse buckets a human reads to find the bottleneck of a concern run, without
// parsing the per-phase `[time]` firehose: detection / probe / structural / coupling / render. Sites call
// `addStage(bucket, ms)`; the concern path resets at the start and prints `[stage-summary]` at the end.
const _stageAcc = new Map<string, number>();
export function addStage(name: string, ms: number): void { if (ms > 0) _stageAcc.set(name, (_stageAcc.get(name) ?? 0) + ms); }
export function resetStages(): void { _stageAcc.clear(); }
export function stageSummary(): string {
  if (!_stageAcc.size) return "";
  const total = [..._stageAcc.values()].reduce((a, b) => a + b, 0);
  const parts = [..._stageAcc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}ms`);
  return `[stage-summary] ${parts.join(" | ")} | total ${total}ms`;
}
