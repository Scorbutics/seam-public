// The phase-progress side-channel also records per-phase timing and emits a final machine-parseable
// @@SEAM_TIMING@@ summary (so the MCP server / skill can tell the user how long each step took). The
// per-phase @@SEAM_PROGRESS@@ markers stay byte-identical (timing lives only in the separate summary).
import { describe, expect, test } from "bun:test";
import { emit, emitTimingSummary, resetTimings, PREFIX, TIMING_PREFIX } from "../../src/core/progress.js";

describe("progress timing summary", () => {
  test("emitTimingSummary writes a parseable marker with every phase + a total", () => {
    resetTimings();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
    try { emit("Scanning…"); emit("Growing…"); emitTimingSummary(); }
    finally { (process.stderr as any).write = orig; }

    // per-phase markers unchanged (PREFIX + message, no timing inline)
    expect(lines).toContain(`${PREFIX} Scanning…\n`);
    const summary = lines.find((l) => l.startsWith(TIMING_PREFIX));
    expect(summary).toBeDefined();
    const t = JSON.parse(summary!.slice(TIMING_PREFIX.length).trim());
    expect(t.phases.map((p: any) => p.phase)).toEqual(["Scanning…", "Growing…"]);
    expect(typeof t.totalMs).toBe("number");
    // durationMs is forward (start → next phase / end), so it's defined even for the LAST phase
    expect(t.phases.every((p: any) => typeof p.durationMs === "number")).toBe(true);
  });

  test("emitTimingSummary is a no-op when nothing was timed", () => {
    resetTimings();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
    try { emitTimingSummary(); } finally { (process.stderr as any).write = orig; }
    expect(lines.some((l) => l.startsWith(TIMING_PREFIX))).toBe(false);
  });
});
