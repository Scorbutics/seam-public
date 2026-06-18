// Port of src/core/progress.py — phase-progress side-channel. A one-line, machine-parseable marker
// on STDERR (stdout carries the --emit-seams / report payload). The VS Code host strips PREFIX and
// shows `message` verbatim. Markers are unconditional (not gated on --verbose); the host needs them.
export const PREFIX = "@@SEAM_PROGRESS@@";
// A final machine-parseable timing summary, emitted once at the end of a run, so a client (MCP / the
// skill) can tell the user how long each phase took. Separate marker so the per-phase PREFIX lines stay
// byte-identical (no UX/test change). Carries every emit()'d phase with its delta + cumulative time.
export const TIMING_PREFIX = "@@SEAM_TIMING@@";

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
