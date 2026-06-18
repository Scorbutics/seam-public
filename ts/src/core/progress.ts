// Port of src/core/progress.py — phase-progress side-channel. A one-line, machine-parseable marker
// on STDERR (stdout carries the --emit-seams / report payload). The VS Code host strips PREFIX and
// shows `message` verbatim. Markers are unconditional (not gated on --verbose); the host needs them.
export const PREFIX = "@@SEAM_PROGRESS@@";
// A final machine-parseable timing summary, emitted once at the end of a run, so a client (MCP / the
// skill) can tell the user how long each phase took. Separate marker so the per-phase PREFIX lines stay
// byte-identical (no UX/test change). Carries every emit()'d phase with its delta + cumulative time.
export const TIMING_PREFIX = "@@SEAM_TIMING@@";

type Phase = { phase: string; atMs: number; deltaMs: number };
let _t0: number | null = null;
let _tLast = 0;
const _phases: Phase[] = [];

export function emit(message: string): void {
  const now = performance.now();
  if (_t0 === null) { _t0 = now; _tLast = now; }
  _phases.push({ phase: message, atMs: Math.round(now - _t0), deltaMs: Math.round(now - _tLast) });
  _tLast = now;
  process.stderr.write(`${PREFIX} ${message}\n`);
}

// Emit the timing summary marker (no-op if nothing was timed). Call once when a run finishes.
export function emitTimingSummary(): void {
  if (!_phases.length) return;
  const totalMs = Math.round(performance.now() - (_t0 ?? performance.now()));
  process.stderr.write(`${TIMING_PREFIX} ${JSON.stringify({ totalMs, phases: _phases })}\n`);
}

export function resetTimings(): void { _t0 = null; _tLast = 0; _phases.length = 0; }
