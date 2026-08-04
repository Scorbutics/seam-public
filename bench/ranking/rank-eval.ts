// RANKING SCOREBOARD — does the ranking put the files the agent ACTUALLY OPENED in the first N rows?
//
// `bun bench/ranking/rank-eval.ts [case-prefix] [--k 12] [--arm A|B]`
//
// THE QUESTION. Seam emits a broad, correct closure and RANKS it — tier + intent relevance — so a consumer can
// read the head instead of the whole thing. Ranking is therefore only worth what its HEAD is worth. The one
// prior measurement said the head is worth less than a crude citation count (30% vs 58% of read demand at
// top-12), which is the reason the ranking is being reworked structurally. This turns that one-off into a
// scoreboard: several candidate rankings over the SAME closure, scored against the SAME demand, offline.
//
// WHAT IS HELD FIXED. Every ranking here ranks the identical candidate set — the files cited by one stored
// grow. No ranking gets to find a file another cannot: this measures ORDER, and only order. That is the whole
// point, because the prior finding was not "Seam misses the file", it was "Seam has the file at rank 40".
//
// THE RECALL CEILING IS PRINTED FIRST, and nothing below it means anything without it. If the grow never
// cited a demanded file, NO ordering of that grow can surface it, and a ranking scoring 60% against a 70%
// ceiling is doing far better than one scoring 60% against 100%. Reporting coverage without the ceiling would
// charge the ranking for the engine's recall — the exact conflation that makes a ranking number unusable.
//
// THE ARMS, and why the default is A. Arm A never saw Seam, so its opens are what the TASK demanded; arm B's
// opens are downstream of the ranking under test and reward it for what it already showed. See demand.ts.
//
// THE FOUR RANKINGS
//   current     tier band (spine < supporting < off < unscored), then relevance desc — WHAT SHIPS TODAY.
//   relevance   raw cosine desc, no banding — isolates how much the tier banding contributes.
//   citations   how many hunks in the closure cite the file — the crude baseline that beat `current`. It is
//               here because a candidate ranking that cannot beat counting is not worth shipping.
//   structural  distance-through-node on the RESOLVED edge graph: hops(center -> file) + hops(file ->
//               boundary), where a boundary is an endpoint of a route/db/key/egress edge. A flow links an
//               entrypoint to an output, so the files on a short center-to-boundary path are the flow.
import { join, dirname } from "node:path";
import { demand, growOf, signals, type Sig } from "./lib.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const K = Number(argv[argv.indexOf("--k") + 1]) || 12;
const ARM = (argv[argv.indexOf("--arm") + 1] === "B" ? "B" : "A") as "A" | "B";
const prefix = argv.find((a) => !a.startsWith("--") && !/^\d+$/.test(a) && a !== "A" && a !== "B") ?? "kc";

// ── the rankings ─────────────────────────────────────────────────────────────────────────────────────────────
type Ranking = { name: string; order: (s: Sig[], demand: Map<string, number>) => Sig[] };
const byFile = (a: Sig, b: Sig) => a.file.localeCompare(b.file);   // a total order, so no run depends on Map order
const RANKINGS: Ranking[] = [
  // THE HARNESS'S SELF-TEST, and it is first on purpose. `oracle` ranks by the answer — the demand itself — so
  // it is the most any ordering of this closure could score at this K. If oracle does not sit at (or just
  // under, when demand is wider than K) the ceiling, the scoreboard is measuring its own plumbing and every
  // other column is noise. A benchmark whose best arm cannot win is the failure this project keeps hitting.
  { name: "oracle", order: (s, d) => [...s].sort((a, b) => (d.get(b.file) ?? 0) - (d.get(a.file) ?? 0) || byFile(a, b)) },
  { name: "current",    order: (s) => [...s].sort((a, b) => a.tier - b.tier || b.rel - a.rel || byFile(a, b)) },
  { name: "relevance",  order: (s) => [...s].sort((a, b) => b.rel - a.rel || byFile(a, b)) },
  { name: "citations",  order: (s) => [...s].sort((a, b) => b.cites - a.cites || byFile(a, b)) },
  // THE STRUCTURAL FAMILY — the same distance-through-node primary key, THREE different tie-breaks, because
  // which one wins is the open question and guessing it is how the current ranking got here. `hops` is the
  // ablation: center distance alone, no boundary term, so the boundary half has to earn its place.
  { name: "hops",       order: (s) => [...s].sort((a, b) => a.hops - b.hops || b.cites - a.cites || byFile(a, b)) },
  { name: "struct",     order: (s) => [...s].sort((a, b) => a.through - b.through || b.cites - a.cites || byFile(a, b)) },
  { name: "struct+rel", order: (s) => [...s].sort((a, b) => a.through - b.through || b.rel - a.rel || byFile(a, b)) },
  { name: "struct+tier", order: (s) => [...s].sort((a, b) => a.through - b.through || a.tier - b.tier || b.rel - a.rel || byFile(a, b)) },
  // LEXICOGRAPHIC, NOT ADDITIVE — the fix `boundary.ts` predicts. `hops + toB` prices one hop of centre
  // distance exactly like one hop of boundary distance; measured on keycloak, hops carries lift 12.31 at k=1
  // against toB's 0.07, so the sum lets a nearly worthless term outvote the strongest one. That is how
  // `keycloak-admin-client/src/client.ts` (hops=1, toB=2) got pushed out of the head in 11 cases by files
  // three hops further from the centre. Ordering by hops FIRST and using toB only inside a band keeps the
  // real signal toB does carry (at hops=1: 0.54 opens/file at toB=0 against 0.16 at toB=2) and discards the
  // part that is noise (at hops=2: 0.12 against 0.13; at hops=4 it inverts).
  { name: "hops>toB", order: (s) => [...s].sort((a, b) => a.hops - b.hops || a.toB - b.toB || b.cites - a.cites || byFile(a, b)) },
  // AND AS A BOOLEAN, because the lift tables say `toB` is not a distance: on both repos it spikes at k=0
  // (3.19 / 2.40) and collapses at k=1 (0.07 / 0.08) with no ordering after. "Touches a boundary" may be the
  // real predicate, and "how far from one" an artefact of treating it as a metric.
  // THE ENGINE'S OWN HOP NUMBER, measured before anything is keyed on it. `hops` is this bench's BFS over the
  // closure's edges; `shell` is what the grow already records per seam. If they do not score the same, an
  // implementation that re-keys on `shell` does NOT inherit `hops`' result — it inherits `shell`'s.
  { name: "engine", order: (s) => [...s].sort((a, b) => a.ehops - b.ehops || b.cites - a.cites || byFile(a, b)) },
  { name: "shell", order: (s) => [...s].sort((a, b) => a.shell - b.shell || b.cites - a.cites || byFile(a, b)) },
  { name: "hops>atB", order: (s) => [...s].sort((a, b) => a.hops - b.hops || (a.toB === 0 ? 0 : 1) - (b.toB === 0 ? 0 : 1) || b.cites - a.cites || byFile(a, b)) },
];

// ── score ────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = { case: string; ceiling: number; demandOpens: number; cov: Record<string, number> };
const rows: Row[] = [];
const skipped: string[] = [];

const cases = [...new Set(demand.filter((c) => c.case.startsWith(prefix)).map((c) => c.case))].sort();
for (const id of cases) {
  const target = demand.find((c) => c.case === id && c.arm === ARM);
  const seamArm = demand.find((c) => c.case === id && c.arm === "B");
  if (!target || !seamArm) { skipped.push(`${id}: missing an arm`); continue; }
  const opens = [...target.reads, ...target.bashReads];
  if (!opens.length) { skipped.push(`${id}: arm ${ARM} opened nothing`); continue; }
  // the case's own grow: the widest one it ran (a `--query` shape is a different question, not the closure)
  const growCmd = seamArm.seamCmds.filter((c) => /--center/.test(c) && !/--query/.test(c) && !/--locate/.test(c))
    .sort((a, b) => b.length - a.length)[0];
  if (!growCmd) { skipped.push(`${id}: no center-grow in the seam arm`); continue; }
  const grow = growOf(growCmd);
  if (!grow) { skipped.push(`${id}: grow replay produced nothing`); continue; }

  const sig = signals(grow);
  if (sig.size < 20) { skipped.push(`${id}: closure has ${sig.size} file(s) — too small to be a real replay`); continue; }
  const cands = [...sig.values()];
  const inClosure = (f: string) => sig.has(f);
  const ceiling = opens.filter(inClosure).length / opens.length;
  const want = new Map<string, number>();
  for (const f of opens) want.set(f, (want.get(f) ?? 0) + 1);
  const cov: Record<string, number> = {};
  for (const r of RANKINGS) {
    const head = new Set(r.order(cands, want).slice(0, K).map((s) => s.file));
    cov[r.name] = opens.filter((f) => head.has(f)).length / opens.length;
  }
  rows.push({ case: id, ceiling, demandOpens: opens.length, cov });
}

// A SCOREBOARD WITH NO CASES IS NOT A TIE. Refuse rather than print four zeros.
if (!rows.length) {
  console.error(`ABORT: 0 case(s) scored for prefix '${prefix}', arm ${ARM}.`);
  for (const s of skipped) console.error(`   skipped — ${s}`);
  process.exit(3);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log(`\n══════ RANKING SCOREBOARD — top-${K}, arm ${ARM} (${ARM === "A" ? "grep: ranking-independent" : "seam: downstream of the ranking"}), ${rows.length} case(s)\n`);
console.log(`   ${"case".padEnd(10)} ${"opens".padStart(6)} ${"ceiling".padStart(8)}   ${RANKINGS.map((r) => r.name.padStart(10)).join(" ")}`);
for (const r of rows)
  console.log(`   ${r.case.padEnd(10)} ${String(r.demandOpens).padStart(6)} ${pct(r.ceiling).padStart(8)}   ${RANKINGS.map((k) => pct(r.cov[k.name]).padStart(10)).join(" ")}`);

const mean = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0) / rows.length;
console.log(`   ${"".padEnd(10)} ${"".padStart(6)} ${"".padStart(8)}   ${RANKINGS.map(() => "─".repeat(10)).join(" ")}`);
console.log(`   ${"MEAN".padEnd(10)} ${"".padStart(6)} ${pct(mean((r) => r.ceiling)).padStart(8)}   ${RANKINGS.map((k) => pct(mean((r) => r.cov[k.name])).padStart(10)).join(" ")}`);
console.log(`\n   CEILING is the share of demand the closure CITES AT ALL — no ordering can beat it. A ranking is`);
console.log(`   doing well relative to its ceiling, not to 100%; the gap to the ceiling is the engine's recall.`);
if (skipped.length) { console.log(`\n   ${skipped.length} case(s) skipped (NOT scored as zero):`); for (const s of skipped) console.log(`     ${s}`); }
console.log();
