// DIFFERENTIAL: Rust `seam_grow::intent_rank` vs the TypeScript oracle (`bandTiers`, `markSpineMembers`).
//
// Unlike the other harnesses this one does NOT run over real footprints, and deliberately. Both functions are
// pure functions of a RELEVANCE VECTOR, and a real grown footprint carries no relevance at all until the
// embed step scores it — so a "real corpus" here would be a corpus of `undefined`, which exercises only the
// early return. The vector shapes ARE the input space, so they are swept systematically instead:
//
//   sizes        1..25 plus 36/48 — the band edges are ceil(n/2), ceil(n/3), ceil(2n/3), and the member cap
//                is min(12, ceil(n/4)), so the interesting n are exactly where those divisions round.
//   ties         plateaus and all-equal vectors — the bands and the cap are decided by SORT POSITION, so a
//                tie is where a stable-vs-unstable sort becomes observable.
//   floor        distributions with and without values under 0.5x the top — the one relative demotion.
//   locked spine — a pre-set structural spine changes the banding to a two-way split.
//   holes        unscored entries interleaved, which must be skipped without shifting anyone's rank.
//
//   bun rust/parity/intent_rank.ts
import { bandTiers, markSpineMembers } from "../../ts/src/codebase/grow/intent_rank.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

const addon: any = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

// deterministic pseudo-random in [0,1) — no Math.random, so a failure is reproducible from its label alone
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

type Vec = { relevance?: number; tier?: string };
const cases: { name: string; seams: Vec[] }[] = [];

const SIZES = [...Array.from({ length: 25 }, (_, i) => i + 1), 36, 48];
for (const n of SIZES) {
  const r = rng(n * 7919);
  const spread = Array.from({ length: n }, () => r());                    // uniform: floor rarely bites
  const wide = Array.from({ length: n }, (_, i) => 1 - i / n);            // linear ramp: floor cuts the tail
  const tight = Array.from({ length: n }, () => 0.8 + r() * 0.05);        // near-equal: rank decides all
  const flat = Array.from({ length: n }, () => 0.5);                      // ALL equal: pure sort stability
  const plateau = Array.from({ length: n }, (_, i) => (i < n / 2 ? 0.9 : 0.2)); // two blocks + a floor cut
  const spike = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0.01)); // one dominant: everything demoted
  for (const [label, vals] of [["spread", spread], ["wide", wide], ["tight", tight], ["flat", flat], ["plateau", plateau], ["spike", spike]] as [string, number[]][]) {
    cases.push({ name: `${label}/n=${n}`, seams: vals.map((v) => ({ relevance: v })) });
    // holes: every third entry unscored — must be skipped, not counted in n, not re-ranked
    cases.push({ name: `${label}/n=${n}/holes`, seams: vals.map((v, i) => (i % 3 === 2 ? {} : { relevance: v })) });
    // a structural spine already locked — banding becomes a two-way split over the REMAINDER
    cases.push({ name: `${label}/n=${n}/locked`, seams: vals.map((v, i) => (i === 0 ? { relevance: v, tier: "spine" } : { relevance: v })) });
    // a pre-existing NON-spine tier must be overwritten, not preserved
    cases.push({ name: `${label}/n=${n}/pretier`, seams: vals.map((v) => ({ relevance: v, tier: "supporting" })) });
  }
}
cases.push({ name: "empty", seams: [] });
cases.push({ name: "all-unscored", seams: [{}, {}, {}] });
cases.push({ name: "zeros", seams: [{ relevance: 0 }, { relevance: 0 }, { relevance: 0 }] });
cases.push({ name: "negatives", seams: [{ relevance: -1 }, { relevance: -0.5 }, { relevance: 0.3 }] });
cases.push({ name: "only-spine", seams: [{ relevance: 0.9, tier: "spine" }, { relevance: 0.8, tier: "spine" }] });

let okB = 0, badB = 0, okM = 0, badM = 0, tiered = 0, spined = 0, capped = 0, demoted = 0;
const fails: string[] = [];

for (const { name, seams } of cases) {
  // ---- bandTiers -----------------------------------------------------------------------------------------
  const ts = seams.map((s) => ({ ...s }));
  bandTiers(ts);
  const rsTiers = JSON.parse(addon.growBandTiers(seams.map((s) => s.relevance), seams.map((s) => s.tier)));
  const rs = seams.map((s, i) => ({ ...s, tier: rsTiers[i] ?? undefined }));
  const nb = (xs: any[]) => JSON.stringify(xs.map((s) => s.tier ?? null));
  tiered += ts.filter((s) => s.tier).length;
  demoted += ts.filter((s) => s.tier === "off").length;
  if (nb(ts) === nb(rs)) okB++;
  else { badB++; if (fails.length < 6) fails.push(`bandTiers ${name}\n  TS: ${nb(ts).slice(0, 240)}\n  RS: ${nb(rs).slice(0, 240)}`); }

  // ---- markSpineMembers ----------------------------------------------------------------------------------
  const th = seams.map((s) => ({ relevance: s.relevance }));
  markSpineMembers(th);
  const rhFlags = JSON.parse(addon.growMarkSpineMembers(seams.map((s) => s.relevance)));
  const rh = seams.map((_, i) => ({ spine: rhFlags[i] ?? undefined }));
  const nm = (xs: any[]) => JSON.stringify(xs.map((h) => h.spine ?? null));
  const marked = th.filter((h: any) => h.spine).length;
  spined += marked;
  // the cap actually bit: more members are at-or-above the mean than the cap allows
  const scored = th.filter((h: any) => typeof h.relevance === "number");
  const mean = scored.reduce((a: number, h: any) => a + h.relevance, 0) / (scored.length || 1);
  if (scored.length > 1 && scored.filter((h: any) => h.relevance >= mean).length > marked) capped++;
  if (nm(th) === nm(rh)) okM++;
  else { badM++; if (fails.length < 6) fails.push(`markSpineMembers ${name}\n  TS: ${nm(th).slice(0, 240)}\n  RS: ${nm(rh).slice(0, 240)}`); }
}

console.log(`intent-rank parity: bandTiers ${okB} ok / ${badB} bad, markSpineMembers ${okM} ok / ${badM} bad`);
console.log(`  (cases ${cases.length}, tiers assigned ${tiered}, demoted-to-off ${demoted}, members marked ${spined}, cases where the cap bit ${capped})`);
for (const x of fails) console.log("  " + x);
if (badB || badM) process.exit(1);
