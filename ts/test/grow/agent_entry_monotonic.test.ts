// REGRESSION — RAISING `--max-nodes` PRODUCED A SMALLER, WORSE "## In".
//
// Measured on cal.com (same command, only --max-nodes differing; intent "how does a payment flow from checkout
// through to the booking being confirmed as paid?"): at --max-nodes 120 the entry surface named
// `RegularBookingService.createBooking (…/RegularBookingService.ts:3061)` — the checkout entry a blind grader
// decided the round on — at rank 2 of 68 ways in. At 400 it was GONE. Not cropped by the display cap: absent
// from the ray list entirely, and the whole render shrank 347 → 198 lines.
//
// ROOT CAUSE (measured with a probe over `buildEntrySurface`, not assumed). `entryOf` climbs from a consumer of
// the mechanism up to "an entry point" by taking, at every hop, THE SINGLE LEAST-SHARED CALLER, and returns only
// the TERMINUS. Both properties break under a bigger region:
//   - a node with NO caller in the small region IS the terminus — probe at 120: `createBooking … callIn=[]` — and
//     at 400 it had gained ten callers, so the walk climbed straight past it and it stopped being named at all;
//   - which of those branches wins is an arbitrary fan-in tiebreak over a fan-in the grow keeps changing, so the
//     terminus hopped to an off-tier, unscored node (`CalendarSyncService.handleEvents`, relevance −1) and the
//     whole ray sank from rank 2/68 to rank 67/84 — far below the 16-row display cap.
// So MORE budget REMOVED a grounded answer, twice over.
//
// THE INVARIANT PINNED HERE — ENTRY-SURFACE MONOTONICITY:
//   every entry the "## In" section CITES at a given node population is still CITED at any larger one.
// Enforced structurally, not by a special case: a ray carries the whole bounded call-upstream CONE of its
// interaction (a set that can only GAIN members as the region grows), and "## In" renders that cone, deduped
// across the shown rows, as its own `…and behind those` block naming each node at its own file:line.
//
// WHY A HAND-BUILT MODEL and not the sibling `agent_entry_surface.test.ts`'s real tmp repo: this defect only
// exists when the SAME question is answered over TWO DIFFERENT node populations, and in a small hermetic repo
// --max-nodes does not move the upstream population at all (measured: the four route callers of `createBooking`
// were absent at both maxNodes 10 and 400 — that is the separate upstream-depth defect). The two populations are
// therefore expressed directly, which is also exactly where the defect lives: render/entry_surface.ts consumes a
// model and nothing else. No repo, no tree-sitter, so no `available()` guard is needed.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

const MECH = { file: "payments/handlePayment.ts", symbol: "handlePayment" };
const INTENT = "how does a payment flow from checkout through to the booking being confirmed as paid";

const hunk = (id: string, label: string, file: string, start: number, relevance: number, enclosing?: string) =>
  ({ id, label, file, start, role: "core", tier: "spine", relevance, ...(enclosing ? { enclosing } : {}) });
const seam = (id: string, hs: any[], tier = "spine") => ({ id, label: hs[0].label, tier, relevance: hs[0].relevance, hunks: hs });

/**
 * SMALL = the --max-nodes 120 shape: the mechanism, the one thing that calls it (`handler`), and `handler`'s only
 * caller `createBooking`, which nothing calls — so it is the climb's terminus and "## In" names it.
 * LARGE = the --max-nodes 400 shape: the SAME graph plus `createBooking`'s ten callers and a second, off-subject
 * caller of `handler`. `createBooking` now has fan-in 10 and `syncEvents` fan-in 0, so the least-shared-caller
 * tiebreak reroutes the climb through `syncEvents` and straight past `createBooking`.
 */
const makeModel = (large: boolean) => {
  const seams: any[] = [
    seam("sM", [hunk("M", "handlePayment", MECH.file, 12, 0.62)]),
    seam("sH", [hunk("H", "handler", "bookings/RegularBookingService.ts", 584, 0.31, "RegularBookingService")]),
    seam("sCB", [hunk("CB", "createBooking", "bookings/RegularBookingService.ts", 3061, 0.29, "RegularBookingService")]),
  ];
  const edges: any[] = [{ from: "H", to: "M", kind: "call" }, { from: "CB", to: "H", kind: "call" }];
  if (large) {
    // the ten callers `createBooking` gains once the region is bigger…
    for (let i = 0; i < 10; i++) {
      seams.push(seam(`sR${i}`, [hunk(`R${i}`, `route${i}`, `api/route${i}.ts`, 10 + i, 0.2 - i * 0.01)]));
      edges.push({ from: `R${i}`, to: "CB", kind: "call" });
    }
    // …and the zero-fan-in sibling caller the tiebreak then prefers (unscored + off-tier, so its ray sinks).
    seams.push({ id: "sSY", label: "syncEvents", tier: "off", hunks: [{ id: "SY", label: "syncEvents", file: "calendar/CalendarSyncService.ts", start: 44, role: "core", tier: "off", enclosing: "CalendarSyncService" }] });
    edges.push({ from: "SY", to: "H", kind: "call" });
  }
  return { mode: "codebase", anchor: "M", resolutionQuality: "FULL", complete: true, blindspots: [], edges,
    clusters: [{ id: "g1", intent: INTENT, spine: [], seams }] };
};

const render = (large: boolean) => renderAgent(makeModel(large), { tokenBudget: 40000, intent: INTENT, centers: [MECH] });
const inSection = (agent: string): string => {
  const a = agent.indexOf("## In (");
  if (a < 0) return "";
  const b = agent.indexOf("\n## ", a + 1);
  return agent.slice(a, b < 0 ? undefined : b);
};
// every `file:line` the "## In" section CITES — the grounded-entry identity the invariant is stated over.
const citations = (seg: string): Set<string> => new Set([...seg.matchAll(/\(([\w./[\]-]+\.\w+:\d+)\)/g)].map((m) => m[1]));

const CB_CITE = "bookings/RegularBookingService.ts:3061";

describe("renderAgent — a bigger node population is MONOTONE in the entry surface", () => {
  test("the two populations really differ (otherwise the invariant is untested)", () => {
    const small = citations(inSection(render(false))), large = citations(inSection(render(true)));
    expect(small.size).toBeGreaterThan(0);
    expect(large.size).toBeGreaterThan(small.size);
  });

  test("the small population names the checkout entry (this is what the bigger one must not lose)", () => {
    expect(inSection(render(false))).toContain(CB_CITE);
  });

  test("MONOTONICITY: every entry cited at the small population is still cited at the large one", () => {
    const small = citations(inSection(render(false))), large = citations(inSection(render(true)));
    expect([...small].filter((c) => !large.has(c))).toEqual([]);
  });

  test("specifically: the node the bigger region climbs PAST is still named, at its own line", () => {
    // pre-fix this was the whole defect — the climb rerouted through `syncEvents` and `createBooking` vanished.
    expect(inSection(render(true))).toContain(CB_CITE);
  });

  test("nothing is fabricated: every citation is a node the model actually carries", () => {
    const known = new Set<string>();
    for (const s of (makeModel(true).clusters[0].seams as any[])) for (const h of s.hunks) known.add(`${h.file}:${h.start}`);
    for (const c of citations(inSection(render(true)))) expect(known).toContain(c);
  });
});
