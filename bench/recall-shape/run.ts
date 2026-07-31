// SHAPE-LEVEL RECALL — what `--query coupling` actually answers, not what the floor index contains.
//
// `bun bench/recall-shape/run.ts <repo> [cases] [commits]`
//
// WHY THIS EXISTS. `bench/recall` reports a coupling recall number, and it cannot see the coupling shape. Its
// only engine calls are `floorIndex` (files grouped by EXACT key) and `buildModuleGraph`; neither reaches
// `other_side`, where fuzzy route matching, containment, the empty-match fix and corroboration all live. So
// four rounds of coupling work that took keycloak's `realms.ts` from 20 of 25 keys unresolved to 2 of 25 —
// counterpart sites 6 → 58 — moved that harness by nothing, BY CONSTRUCTION. The same blindness was verified in
// `bench/cochange` by running the old and new matcher on one window for byte-identical output.
//
// Those harnesses measure the FLOOR (do two files share an exact key). This measures the SHAPE (does the query
// an agent actually runs find the counterpart), which is the only one of the two that is a product claim.
//
// THE METHOD is deliberately `bench/recall`'s, unchanged: a real multi-file commit, one file shown, the rest is
// ground truth, and the anchor is the commit's most-keyed file. Same cases, same anchor rule, same scoring — so
// the FLOOR and SHAPE arms are directly comparable and the difference is attributable to the projection alone.
//
// COST is why this is sampled. `--query coupling` scans per case, where `floorIndex` is one pass for the whole
// repo. `cases` bounds the sample; the sample is drawn deterministically (a fixed stride, not the head of the
// list) so it is not the first N commits of one directory.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

const [repo, casesArg, commitsArg] = process.argv.slice(2);
if (!repo) { console.error("usage: run.ts <repo> [cases] [commits]"); process.exit(2); }
const MAX_CASES = Number(casesArg ?? 40);
const COMMITS = Number(commitsArg ?? 600);
const HERE = dirname(new URL(import.meta.url).pathname);

const MAX_FILES = 12, MIN_FILES = 2, SEP = "\x01";
const scannable = (f: string) => /\.(ts|tsx|js|jsx|mjs|java|rb|py|c|cc|cpp|h|hpp)$/.test(f);
const sh = (cmd: string): string => {
  try { return execSync(cmd, { cwd: repo, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return ""; }
};

// ── cases: identical selection to bench/recall ───────────────────────────────────────────────────────────────
const all: { sha: string; files: string[] }[] = [];
for (const chunk of sh(`git log -n ${COMMITS} --no-merges --name-only --format=%x01%H`).split(SEP).slice(1)) {
  const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
  const files = lines.slice(1).filter(scannable);
  if (files.length < MIN_FILES || files.length > MAX_FILES) continue;
  all.push({ sha: lines[0], files });
}
if (!all.length) { console.error("ABORT: no usable multi-file commit in the window. Not a result."); process.exit(3); }
// Deterministic STRIDE, not the head: the first N commits cluster in whatever area was worked on last.
const stride = Math.max(1, Math.floor(all.length / MAX_CASES));
const cases = all.filter((_, i) => i % stride === 0).slice(0, MAX_CASES);
process.stderr.write(`${all.length} multi-file commit(s); sampling ${cases.length} at stride ${stride}\n`);

const addon: any = loadAddon();

// ── arm 1: FLOOR — files sharing an exact key (what bench/recall calls "seam") ────────────────────────────────
const rows: string[][] = addon.floorIndex(repo) ?? [];
if (!rows.length) { console.error("ABORT: the floor index is empty. Not a result."); process.exit(3); }
const keyFiles = new Map<string, Set<string>>(), fileKeys = new Map<string, Set<string>>();
for (const [k, , f] of rows) {
  if (!keyFiles.has(k)) keyFiles.set(k, new Set());
  keyFiles.get(k)!.add(f);
  if (!fileKeys.has(f)) fileKeys.set(f, new Set());
  fileKeys.get(f)!.add(k);
}
const HUB = 12;                                    // same hub cap as bench/recall and bench/cochange
const floorNeighbours = (f: string): Set<string> => {
  const out = new Set<string>();
  for (const k of fileKeys.get(f) ?? []) {
    const fs = keyFiles.get(k)!;
    if (fs.size > HUB) continue;
    for (const g of fs) if (g !== f) out.add(g);
  }
  return out;
};

// ── arm 2: SHAPE — what `--query coupling` returns for that anchor ────────────────────────────────────────────
// THE ARM THIS FILE EXISTS FOR. Counts every counterpart site the shape reports, deduped to files.
let shapeErrors = 0;
const shapeNeighbours = (f: string): Set<string> => {
  const out = new Set<string>();
  try {
    const c: any = addon.projectCoupling(repo, f, undefined);
    for (const k of c?.keys ?? []) for (const s of k.sides ?? []) if (s.file && s.file !== f) out.add(s.file);
  } catch { shapeErrors++; }
  return out;
};

// ── score ────────────────────────────────────────────────────────────────────────────────────────────────────
type Acc = { hit: number; actual: number; predicted: number; cases: number };
const acc = (): Acc => ({ hit: 0, actual: 0, predicted: 0, cases: 0 });
const floor = acc(), shape = acc();

for (const c of cases) {
  const anchor = [...c.files].sort((a, b) => (fileKeys.get(b)?.size ?? 0) - (fileKeys.get(a)?.size ?? 0))[0];
  const actual = new Set(c.files.filter((f) => f !== anchor));
  if (!actual.size) continue;
  for (const [a, pred] of [[floor, floorNeighbours(anchor)], [shape, shapeNeighbours(anchor)]] as const) {
    a.cases++; a.actual += actual.size; a.predicted += pred.size;
    for (const f of pred) if (actual.has(f)) a.hit++;
  }
}

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) + "%" : "—");
console.log(`\n══════ SHAPE-LEVEL RECALL — ${repo}`);
console.log(`   ${floor.cases} case(s) — the SAME cases, anchors and scoring as bench/recall\n`);
console.log(`   arm        recall            precision         predicted/case`);
for (const [name, a] of [["floor", floor], ["shape", shape]] as const)
  console.log(`   ${name.padEnd(10)} ${pct(a.hit, a.actual).padStart(6)} (${a.hit}/${a.actual})`.padEnd(38)
    + `${pct(a.hit, a.predicted).padStart(6)}`.padEnd(18) + (a.predicted / Math.max(a.cases, 1)).toFixed(1));

// A shape arm that answers nothing is a BROKEN ARM, not a finding — the recurring failure in this project.
if (!shape.predicted) {
  console.error(`\nABORT: the shape arm predicted NOTHING across ${shape.cases} case(s)`
    + `${shapeErrors ? ` (${shapeErrors} threw)` : ""}. That is a broken arm, not a measurement.`);
  process.exit(3);
}
if (shapeErrors) console.log(`\n   WARNING: projectCoupling threw on ${shapeErrors} case(s) — treated as empty, so this is a LOWER bound.`);
console.log(`\n   FLOOR is what bench/recall scores: files sharing an EXACT key. SHAPE is what an agent actually`);
console.log(`   calls. Where they differ, the difference is the projection — fuzzy route matching, containment`);
console.log(`   and corroboration — none of which the floor arm can see.`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `shape-${repo.replace(/[^a-z0-9]+/gi, "_")}.json`),
  JSON.stringify({ repo, cases: floor.cases, floor, shape, shapeErrors }, null, 2));
