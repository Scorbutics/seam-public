// Single-def file --center → STRUCTURAL anchor, not concern. A bare `--center <file>` leaves the symbol
// unset, which routes an intent grow into concern/center-first mode — SEMANTIC, region + Cross-stack ranked by
// intent RELEVANCE, which can crown an off-subject shared-key cluster over the structurally-nearer flow (the
// acme `AcmeCheckBookingsService.java` bug: a high-fan `/member/v1/survey` route out-scoring the real
// `/member/booking/v1` routes). When the file holds exactly ONE top-level definition (single-class Java file /
// single exported component), the user means "anchor THAT symbol" — identical to `--center <file>#<Sym>` — so
// Seam resolves it STRUCTURALLY and pins the symbol, taking the direct trace. A file with ≥2 top-level defs is
// genuinely plural → stays module/concern. Offline (`--data-coupling floor`). Guards on tree-sitter.
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

describe("single-def file --center → structural anchor (not concern)", () => {
  test("bare-file center on a single-class file takes the DIRECT trace, identical to explicit #symbol", () => {
    if (!available()) return;   // needs tree-sitter to grow the Java anchor
    const bare = run(["--center", "ejb/BookingsBean.java"]);
    const pinned = run(["--center", "ejb/BookingsBean.java#BookingsBean"]);
    // BEHAVIOURAL CONTRACT: the bare-file render is IDENTICAL to the explicitly-pinned one (same anchor, same path)
    expect(bare.stdout).toContain("anchor: BookingsBean");
    expect(bare.stdout.trim()).toBe(pinned.stdout.trim());
    // and it took the DIRECT trace, NOT the concern/center-first star (the path this fix changes)
    expect(bare.stderr).toContain("direct trace (no concern star)");
    expect(bare.stderr).not.toContain("[center-first]");
    expect(bare.stderr).toContain("single top-level definition 'BookingsBean'");
  }, 60000);

  test("bare-file center on a MULTI-def file stays module/concern (no structural pin)", () => {
    if (!available()) return;
    const bare = run(["--center", "web/memberBookings.js"]);   // loadBookings + cancelBooking → genuinely plural
    expect(bare.stderr).not.toContain("single top-level definition");
    expect(bare.stderr).toContain("[center-first]");           // stays the concern/center-first path
  }, 60000);
});
