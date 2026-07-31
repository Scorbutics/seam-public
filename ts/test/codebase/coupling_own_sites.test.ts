// THE COUPLING SHAPE MUST CITE THE ANCHOR'S OWN ACCESS SITE — the near side, not only the far one.
//
// THE MEASUREMENT (bench/grep-vs-seam, cal-booking-flow, 2026-07-31). The task was "where does `createBooking`
// write to the database". Across a whole agent run Seam emitted 41,606 characters containing ZERO lines with
// `prisma.` and zero `.create(` calls. `--query coupling` on that anchor returned 4 shared keys, 241 counterpart
// sites and 383 lines — and:
//
//     grep -c "createBooking.ts" <the coupling output>   →   0
//
// The anchor did not appear in its own coupling output. Every citation was a counterpart. Meanwhile the shape's
// own heading read `## db-table "booking"  — anchor writes`, and that verb is DERIVED from the anchor's hits, so
// the engine held `createBooking.ts:187` (`await tx.booking.create(createBookingObj)`) and printed only the verb.
// Asked where the anchor touches the DB, it answered with 241 other places. The agent opened the file, every run.
//
// THE LINE THIS FILE DEFENDS: a shape that asserts a role must be able to cite the site it read that role from.
// `sides` is deliberately the OTHER side (`project_coupling` skips `acc.file == anchor_file`), so before
// `own_sites` existed NO field carried the near side and no render could have recovered it.
//
// Falsified before being believed, per the standing rule, in BOTH of the ways this could go wrong:
//   - emptying `own_sites` in coupling_shape.rs           → 5 of 7 fail
//   - dropping the 0-based→1-based conversion on the line → 4 of 7 fail
// The two survivors in each case are the far-side control and the legend assertion, neither of which reads the
// field. The first run of the falsification had THREE survivors: "the enclosing unit is resolved" was a bare
// `for…of` over `ownSites` and passed on an empty array. It is now length-guarded.
import { describe, expect, test, beforeAll } from "bun:test";
import { projectCoupling } from "../helpers/shapes.js";
import { renderCoupling } from "../../src/codebase/render/shapes.js";
import { makeSnippetReader } from "../../src/codebase/render/snippets.js";

const REPO = "test/fixtures/own-access-repo";
const ANCHOR = "src/saveBooking.ts";
let scoped: any;   // --center src/saveBooking.ts#saveBooking
let whole: any;    // --center src/saveBooking.ts
const key = (m: any) => (m.keys ?? []).find((k: any) => k.value === "bookings");

beforeAll(async () => {
  scoped = await projectCoupling(REPO, ANCHOR, "saveBooking");
  whole = await projectCoupling(REPO, ANCHOR);
});

describe("the anchor's own access sites are carried", () => {
  test("the key exists and the far side is non-empty", () => {
    // The near-side assertions below would pass vacuously on a one-sided key — the shape could be reporting the
    // anchor simply because it had nothing else to report. This pins that the counterpart walk still works.
    const k = key(scoped);
    expect(k).toBeTruthy();
    expect(k.anchorRole).toBe("writes");
    expect(k.sides.map((s: any) => s.file)).toEqual(["src/otherReader.ts"]);
  });

  test("both writes inside the anchor span are cited, with 1-based lines", () => {
    // 13 is `tx.bookings.update(...)`, 14 is `tx.bookings.create(...)`. Line numbers are the whole point of the
    // field: an off-by-one here sends the reader to the wrong statement, which is worse than no citation at all
    // (a bare path at least tells them to go and look).
    const own = key(scoped).ownSites;
    expect(own.map((s: any) => s.line)).toEqual([13, 14]);
    expect(own.every((s: any) => s.file === ANCHOR)).toBe(true);
  });

  test("a TRANSACTION-ALIAS receiver is not missed", () => {
    // `tx.bookings.create(...)`, not `prisma.bookings.create(...)`. This is the form the real cal.com write uses,
    // and a site pass that matched the client receiver literally would show nothing for the one line the whole
    // fix exists to point at. Asserting the SOURCE TEXT at the cited line, not just that a line exists.
    const line = key(scoped).ownSites.find((s: any) => s.line === 14);
    expect(line).toBeTruthy();
    expect(line.role).toBe("writes");
    const src = renderCoupling(scoped, mkReader());
    expect(src).toContain("tx.bookings.create(");
  });

  test("the enclosing unit is resolved, not the file stem", () => {
    // THE LENGTH ASSERTION IS LOAD-BEARING. Written as a bare `for…of`, this case passed on an EMPTY
    // `ownSites` — caught during the falsification run, where it was one of three survivors. A loop over
    // nothing asserts nothing; this project's recurring null-answer trap, in its smallest possible form.
    expect(key(scoped).ownSites.length).toBe(2);
    for (const s of key(scoped).ownSites) {
      expect(s.symbol).toBe("saveBooking");
      expect(s.kind).toBe("function");
    }
  });
});

describe("per-site roles, not the key's role copied down", () => {
  test("one key with both roles resolves to per-site reads and writes", () => {
    // Whole-file anchor: `bookings` is read at :5 and written at :13/:14, so anchorRole is "reads+writes". A
    // renderer that stamped the KEY's role onto every site would read correct on any single-role key and be
    // silently wrong here — it would claim `loadBooking` WRITES the table.
    const k = key(whole);
    expect(k.anchorRole).toBe("reads+writes");
    expect(k.ownSites.map((s: any) => [s.line, s.role])).toEqual([[5, "reads"], [13, "writes"], [14, "writes"]]);
    expect(k.ownSites.find((s: any) => s.line === 5).symbol).toBe("loadBooking");
  });
});

describe("the render shows them, and says what they are", () => {
  test("the anchor's own file is cited in its own coupling output", () => {
    // The exact check that returned 0 on cal.com.
    const out = renderCoupling(scoped, mkReader());
    expect(out).toContain(`${ANCHOR}:14`);
    expect(out).toContain("THE ANCHOR'S OWN ACCESS");
  });

  test("the legend explains the marker", () => {
    // A new glyph with no key is a puzzle, and this render is read by agents that cannot ask what it means.
    const out = renderCoupling(scoped, mkReader());
    expect(out).toMatch(/`●` is the ANCHOR'S OWN access/);
  });
});

// The CLI passes a snippet reader; renderCoupling's snippets are optional, so the source-text assertion above
// needs one or it would silently assert against a citation-only render and prove nothing about the snippet path.
// The SHIPPED reader, not a hand-rolled one — a local stand-in would let the render pass here while the real
// snippet path stayed broken, which is the same null-answer shape this project keeps re-finding.
const mkReader = () => makeSnippetReader(REPO, 2);
