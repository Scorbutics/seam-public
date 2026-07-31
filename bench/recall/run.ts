// RECALL — "complete the commit". `bun bench/recall/run.ts <repo> [commits]`
//
// THE QUESTION NOTHING ELSE HERE ANSWERS. `oracle/` measures correctness, `coupling/` measures capability,
// `cochange/` measures precision-in-practice. All three ask "is what Seam SAYS true". None asks **what it
// MISSES**, and that is the first thing a skeptic asks. A tool with perfect precision and 5% recall is a tool
// that will quietly let you ship the broken half of a change.
//
// THE METHOD. Take a real multi-file commit. Hide it. Show only ONE of the files it touched, and ask: which
// OTHER files must change with this one? Score the answer against what the commit actually changed.
//
// The judge is the commit itself — what a human really had to touch, decided before this tool existed. No
// fixture, no LLM, no judgement call.
//
//   recall    = |predicted ∩ actual| / |actual|      <- the number this file exists for
//   precision = |predicted ∩ actual| / |predicted|   <- reported WITH it, because recall alone is gamed by
//                                                       predicting the whole repo
//
// THREE ARMS, the same three as everywhere else:
//   seam   — the anchor file's coupling counterparts (shared keys) PLUS its structural consumers/dependencies.
//            This is what `--query refactor`/`brief` would put in front of an agent.
//   imports— the honest structural baseline: files that import the anchor or are imported by it. This is what a
//            language server can reach, and it is the arm that decides whether coupling adds recall or just noise.
//   random — the base rate, matched on count, so "predicted 30 files and hit some" cannot look like insight.
//
// WHAT IT CANNOT DO. A commit bundles unrelated work (a typo fix rides along with a feature); that inflates the
// denominator and DEPRESSES every arm's recall equally, so the comparison stays fair while the absolute number
// reads low. Read the arms against each other, never the raw percentage on its own. Commits touching more than
// MAX_FILES are dropped as sweeps for the same reason as in `cochange/`.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

const [repo, commitsArg] = process.argv.slice(2);
if (!repo) { console.error("usage: run.ts <repo> [commits]"); process.exit(2); }
const COMMITS = Number(commitsArg ?? 600);
const HERE = dirname(new URL(import.meta.url).pathname);

const MAX_FILES = 12;      // a "one intent" commit; above this it is a sweep and the denominator is noise
const MIN_FILES = 2;       // a single-file commit has nothing to predict
const SEED = 987654321;

const sh = (cmd: string, cwd = repo): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { return ""; }
};

const SEP = "\x01";
const scannable = (f: string) => /\.(ts|tsx|js|jsx|mjs|java|rb|py|c|cc|cpp|h|hpp)$/.test(f);

// ── the cases: real multi-file commits ───────────────────────────────────────────────────────────────────────
const cases: { sha: string; files: string[] }[] = [];
{
  const raw = sh(`git log -n ${COMMITS} --no-merges --name-only --format=%x01%H`);
  for (const chunk of raw.split(SEP).slice(1)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
    const files = lines.slice(1).filter(scannable);
    if (files.length < MIN_FILES || files.length > MAX_FILES) continue;
    cases.push({ sha: lines[0], files });
  }
}
if (!cases.length) { console.error("ABORT: no usable multi-file commit in the window. Not a result."); process.exit(3); }
process.stderr.write(`${cases.length} multi-file commit(s) in the window (${MIN_FILES}..${MAX_FILES} scannable files)\n`);

// ── arm: seam — the repo-wide grounding index (coupling) ─────────────────────────────────────────────────────
const addon: any = loadAddon();
const rows: string[][] = addon.floorIndex(repo) ?? [];
if (!rows.length) { console.error("ABORT: the floor index is empty — the engine found no shared keys. Not a result."); process.exit(3); }
const keyFiles = new Map<string, Set<string>>();     // key -> files touching it
const fileKeys = new Map<string, Set<string>>();     // file -> its keys
for (const [k, , f] of rows) {
  if (!keyFiles.has(k)) keyFiles.set(k, new Set());
  keyFiles.get(k)!.add(f);
  if (!fileKeys.has(f)) fileKeys.set(f, new Set());
  fileKeys.get(f)!.add(k);
}
// A key touched by a large fraction of the repo is a hub, not a coupling — the same cap `cochange/` applies, and
// without it a single `users` table would "predict" half the codebase and buy fake recall.
const HUB = 12;
const seamNeighbours = (f: string): Set<string> => {
  const out = new Set<string>();
  for (const k of fileKeys.get(f) ?? []) {
    const fs = keyFiles.get(k)!;
    if (fs.size > HUB) continue;
    for (const g of fs) if (g !== f) out.add(g);
  }
  return out;
};

// ── arm: imports — what a language server can reach ──────────────────────────────────────────────────────────
// Built from the SAME engine's structural layer, on purpose: the point is to isolate what the COUPLING adds on
// top of ordinary import/call structure, so both arms must share a resolver. A weaker import arm would flatter
// the seam arm for free.
// A BROKEN ARM IS NOT AN ARM PREDICTING NOTHING, and the first version of this was broken: it called the
// SYMBOL-anchored consumer/dependency shapes with `undefined` for the symbol, threw, and the catch turned that
// into an empty prediction. The run printed `imports 0.0% (0/816), 0.0 predicted/case` — a baseline that cannot
// score, in a comparison whose entire purpose is to ask what coupling adds OVER imports. It flattered the seam
// arm for free, and it is the fourth time this project has produced a silent no-answer that looked like a
// result. `build_module_graph` is FILE-anchored, which is what a file-level import baseline actually needs.
let importArmEmpty = 0;
const importNeighbours = (f: string): Set<string> => {
  const out = new Set<string>();
  const g = addon.buildModuleGraph(repo, f, false);
  for (const n of g?.nodes ?? []) if (n.file && n.file !== f) out.add(n.file);
  if (!out.size) importArmEmpty++;
  return out;
};

// ── arm: random, count-matched ───────────────────────────────────────────────────────────────────────────────
const pool = [...new Set(rows.map((r) => r[2]))].filter(scannable);
let _x = SEED;
const rnd = () => ((_x = (_x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const randomNeighbours = (f: string, n: number): Set<string> => {
  const out = new Set<string>();
  for (let t = 0; t < n * 50 && out.size < n; t++) {
    const g = pool[Math.floor(rnd() * pool.length)];
    if (g && g !== f) out.add(g);
  }
  return out;
};

// ── score ────────────────────────────────────────────────────────────────────────────────────────────────────
type Acc = { hit: number; actual: number; predicted: number; cases: number };
const acc = (): Acc => ({ hit: 0, actual: 0, predicted: 0, cases: 0 });
const seam = acc(), imp = acc(), rnd_ = acc(), union = acc();

for (const c of cases) {
  // The anchor is the file with the most shared keys — the one an engineer would most plausibly start from. Ties
  // and zero-key commits fall back to the first file, so no commit is silently skipped.
  const anchor = [...c.files].sort((a, b) => (fileKeys.get(b)?.size ?? 0) - (fileKeys.get(a)?.size ?? 0))[0];
  const actual = new Set(c.files.filter((f) => f !== anchor));
  if (!actual.size) continue;

  const sN = seamNeighbours(anchor);
  const iN = importNeighbours(anchor);
  const uN = new Set([...sN, ...iN]);
  const rN = randomNeighbours(anchor, Math.max(sN.size, 1));

  for (const [a, pred] of [[seam, sN], [imp, iN], [rnd_, rN], [union, uN]] as const) {
    a.cases++;
    a.actual += actual.size;
    a.predicted += pred.size;
    for (const f of pred) if (actual.has(f)) a.hit++;
  }
}

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(1) + "%" : "—");
console.log(`\n══════ RECALL — "complete the commit" — ${repo}`);
console.log(`   ${seam.cases} case(s); the anchor is the commit's most-keyed file, the rest is ground truth\n`);
console.log(`   arm        recall            precision         predicted/case`);
for (const [name, a] of [["seam", seam], ["imports", imp], ["seam+imports", union], ["random", rnd_]] as const)
  console.log(`   ${name.padEnd(12)} ${pct(a.hit, a.actual).padStart(6)} (${a.hit}/${a.actual})`.padEnd(38)
    + `${pct(a.hit, a.predicted).padStart(6)}`.padEnd(18) + (a.predicted / Math.max(a.cases, 1)).toFixed(1));
// If the import baseline is empty on most cases it is not a baseline, whatever its recall says.
if (importArmEmpty > seam.cases / 2)
  console.log(`\n   WARNING: the imports arm predicted NOTHING on ${importArmEmpty}/${seam.cases} cases — treat its`
    + `\n   recall as unmeasured rather than low, and fix the arm before quoting this table.`);
console.log(`\n   Read the arms against each other, not the absolute number: a commit bundles unrelated work, which`);
console.log(`   inflates every denominator equally. What matters is whether COUPLING adds recall over imports.`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `recall-${repo.replace(/[^a-z0-9]+/gi, "_")}.json`),
  JSON.stringify({ repo, cases: seam.cases, seam, imports: imp, union, random: rnd_ }, null, 2));
if (!seam.cases) { console.error("INCONCLUSIVE: no scorable case."); process.exit(1); }
