// Port of src/core/progress.py — phase-progress side-channel. A one-line, machine-parseable marker
// on STDERR (stdout carries the --emit-seams / report payload). The VS Code host strips PREFIX and
// shows `message` verbatim. Markers are unconditional (not gated on --verbose); the host needs them.
export const PREFIX = "@@SEAM_PROGRESS@@";

export function emit(message: string): void {
  process.stderr.write(`${PREFIX} ${message}\n`);
}
