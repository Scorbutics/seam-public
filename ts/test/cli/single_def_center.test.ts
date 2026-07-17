// Single-def file --center → STRUCTURAL resolution, never the SEMANTIC concern center-first. A bare `--center
// <file>` leaves the symbol unset, which would route an intent grow into concern/center-first mode — SEMANTIC,
// region + Cross-stack ranked by intent RELEVANCE, which can crown an off-subject shared-key cluster over the
// structurally-nearer flow (the acme `/member/v1/survey` route out-scoring the real `/member/booking/v1`).
// When the file holds exactly ONE top-level definition, Seam resolves it STRUCTURALLY:
//   • a CLASS with ≥2 methods FANS into a per-method star (each method its own flow — the "transition to all
//     methods"; the class-node collapse that hid every method but one is gone). This is an EXPLICIT multi-center
//     (the class's methods), NOT the LLM center detection, so the off-subject-cluster bug does not return.
//   • a single-def NON-class file (one exported fn) pins that symbol — the direct trace.
// A file with ≥2 top-level defs is genuinely plural → stays module/concern. Offline (`--data-coupling floor`). Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(TS_DIR, "test", "fixtures", "booking-app");
// --verbose un-mutes the quiet-stderr filter so the anchor-path markers are observable.
const run = (args: string[]) =>
  spawnSync("bun", ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--data-coupling", "floor",
    "--intent", "how are bookings managed", "--format", "agent", "--verbose", ...args],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });

describe("single-def file --center → structural resolution (fan a class, pin a lone def)", () => {
  test("bare-file center on a multi-method class FANS into a per-method star (not a collapsed class node)", () => {
    if (!available()) return;   // needs tree-sitter to grow the Java anchor
    const bare = run(["--center", "ejb/BookingsBean.java"]);   // BookingsBean = getUpcomingBookings + persist
    // it FANNED to the class's methods, structurally (the methods are named, not detected)
    expect(bare.stderr).toContain("is a class 'BookingsBean'");
    expect(bare.stderr).toContain("fanning into a per-method star");
    expect(bare.stderr).toContain("pinned 2 center(s): getUpcomingBookings, persist");
    // …and did NOT run the SEMANTIC center detection (the off-subject-cluster path this fix avoids)
    expect(bare.stderr).not.toContain("Picking the concern's mechanism");
    // a class STAR renders the per-method concern MAP (agent upgraded), listing every method — none missing
    expect(bare.stdout).toContain("# Concern map");
    for (const m of ["getUpcomingBookings", "persist"]) expect(bare.stdout).toContain(`BookingsBean.${m}`);
  }, 60000);

  test("bare-file center on a MULTI-def file stays module/concern (no structural fan)", () => {
    if (!available()) return;
    const bare = run(["--center", "web/memberBookings.js"]);   // loadBookings + cancelBooking → genuinely plural
    expect(bare.stderr).not.toContain("single top-level definition");
    expect(bare.stderr).not.toContain("fanning into a per-method star");
    expect(bare.stderr).toContain("[center-first]");           // stays the concern/center-first path
  }, 60000);
});
