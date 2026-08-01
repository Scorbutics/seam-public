// `--format agent` MUST SHOW THE ANCHOR'S OWN DATA ACCESS — the answer to "where does this hit the database".
//
// THE MEASUREMENT (bench/grep-vs-seam, cal-booking-flow, 2026-08-01). The task was "how does a booking get
// created end to end, and where does it hit the database". Anchored on `saveBooking` — the function whose own
// body is `await tx.booking.create(...)` at createBooking.ts:187 — the agent map produced 15.7 kB containing:
//
//     tx.booking.create        0 occurrences
//     `db-write ──▶ booking`   0 occurrences
//
// and its `## Mechanism` section, whose heading promises "what a step persists/reads", listed six steps in
// full: withReporting, redactSensitiveData, createErrorHandler, isPromise, isPrismaObjOrUndefined, isPrismaObj.
// Sentry wrappers and type guards. No sink.
//
// WHY THE GRAPH CANNOT PRODUCE IT, and why this is a section rather than a step:
//   1. `await tx.booking.create(...)` is a method call on a RUNTIME object. It is not a resolved edge to a named
//      unit, so no call-order walk emits it — the call graph is simply the wrong instrument for an ORM write.
//   2. `booking` is a HUB key, and every counterpart section folds hub keys away ("shared by too many unrelated
//      sites to imply a relationship"). That rule is correct for COUNTERPARTS and wrong for the ANCHOR: its own
//      write asserts nothing about a relationship, it is a fact about the code the caller pointed at.
//
// CONSEQUENCE THIS FIXES, measured: the benchmark agent stopped using the flow grow and hand-walked the graph
// with one `--query consumers` per hop instead — 11 such calls across 6 runs. That is Seam-as-grep, and it was
// the CORRECT fallback while the one-call answer did not contain the answer.
//
// Falsified rather than trusted for passing: dropping `anchorAccess` from the render fails 5 of the 6 cases,
// the one survivor being the suppression negative control. The FIRST falsification run had three survivors —
// two content assertions were made against the whole render, and this fixture is small enough that the spine
// reaches the write on its own, so they passed with the feature removed. They now assert against the section.
import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "own-access-repo");
let out = "";

const run = (repo: string, file: string, sym: string) => {
  const r = spawnSync("bun", [CLI, "--repo", repo, "--scan", "--auto", "--intent", "where does this write to the database",
    "--anchor-file", file, "--symbol", sym, "--data-coupling", "floor", "--snippets", "--format", "agent"],
    { encoding: "utf-8", timeout: 600_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

beforeAll(() => { out = run(REPO, "src/saveBooking.ts", "saveBooking"); });

// THE SECTION, not the whole render. Scoping matters more here than it looks: on a fixture small enough for the
// spine to reach the write itself, `expect(out).toContain("tx.bookings.create(")` passes with this feature
// entirely removed — it was doing so during the falsification run. The defect being fixed is specifically that
// on a REAL repo the spine does NOT reach it, so every assertion about content has to be made against the
// section that is supposed to carry it.
const section = (): string => {
  const i = out.indexOf("## Persists / reads");
  if (i < 0) return "";
  const j = out.indexOf("\n## ", i + 1);
  return out.slice(i, j < 0 ? undefined : j);
};

describe("the anchor's own accesses are in the agent map", () => {
  test("the section exists and names the table and the role", () => {
    expect(out).toContain("## Persists / reads");
    expect(section()).toContain(`writes db-table "bookings"`);
  });

  test("it carries the LINE, not just the fact", () => {
    // The whole defect was a shape that knew the verb and withheld the location. A section that said "writes
    // bookings" with no line would reproduce it exactly, and would pass any assertion about the heading.
    expect(section()).toMatch(/saveBooking\.ts:1[34]/);
  });

  test("the SOURCE TEXT of the write is shown", () => {
    // The strongest form: not "there is a write at line 14" but the write itself, so a reader never opens the
    // file. Also pins the TRANSACTION-ALIAS receiver — `tx.bookings.create`, not `prisma.bookings.create`.
    expect(section()).toContain("tx.bookings.create(");
  });

  test("it appears ABOVE the spine, where the answer belongs", () => {
    // Placement is load-bearing under a token budget: below the spine and the mechanism, this section is what
    // the degrade ladder crops first, and the defect returns silently on exactly the large repos that showed it.
    const a = out.indexOf("## Persists / reads");
    const b = out.search(/## Spine/);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
  });

  test("it points at the shape that answers the OTHER side", () => {
    // These are the near side only. Saying so prevents the reader concluding nothing else touches the table —
    // the mirror of the defect this section fixes.
    expect(section()).toContain("--query coupling");
  });
});

describe("the section is bounded — exempt from cropping is not exempt from having a size", () => {
  test("a wide anchor is capped, and the cap is STATED with the true total", () => {
    // Measured on keycloak: this section rendered 7,513 B — the LARGEST in the agent map, and a material part
    // of why that render spilled the tool-result ceiling. It is exempt from the degrade ladder (correctly: it is
    // usually the literal answer) and was also unbounded, which is the worst pair. "A handful of lines" was the
    // assumption when it was written; the measurement disagreed.
    const { renderAgent } = require("../../src/codebase/llm_context.js");
    const access = Array.from({ length: 20 }, (_, i) => ({
      kind: "db-table", value: `t${i}`, role: i % 2 ? "reads" : "writes", file: "src/a.ts", line: i + 1, columns: [],
    }));
    const out = renderAgent({ mode: "codebase", anchor: "n0", clusters: [{ seams: [{ id: "s0", title: "s", role: "core",
      hunks: [{ id: "n0", file: "src/a.ts", symbol: "a", start: 1, kind: "function", label: "a" }] }] }] },
      { intent: "x", anchorAccess: access });
    const sec = out.slice(out.indexOf("## Persists / reads"));
    expect((sec.match(/^  ● /gm) ?? []).length).toBeLessThan(20);   // capped
    expect(sec).toMatch(/showing \d+ of 20 access site\(s\)/);      // …and it says so, with the TRUE total
    expect(sec).toContain("--query coupling");                       // …and where to get the rest
  });

  test("a narrow anchor gets no cap notice", () => {
    // The negative control: a notice that always fires is decoration.
    expect(out).not.toMatch(/showing \d+ of \d+ access site/);
  });
});

describe("suppressed when there is nothing to say", () => {
  test("an anchor with no key access grows no empty heading", () => {
    // The negative control. A heading that always fires is decoration; this one has to be absent when the anchor
    // touches no shared key, or it teaches the reader to skip it.
    const none = run(join(import.meta.dir, "..", "fixtures", "locate-repo"), "src/paymentFlow/charge.ts", "charge");
    expect(none).not.toContain("## Persists / reads");
  });
});
