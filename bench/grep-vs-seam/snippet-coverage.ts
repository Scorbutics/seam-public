// SNIPPET COVERAGE PER SHAPE — of the locations a shape CITES, does it show the code?
//
// `bun bench/grep-vs-seam/snippet-coverage.ts <repo> <file#symbol> [module-file]`
//
// WHY. `verification-tax.ts` binned the post-answer work of every stored benchmark run and found the dominant
// cost is a CONTENT gap: a location cited with nothing to dereference, so the agent opens the file — which costs
// far more than the lines would have. Three shapes had it, each found only by looking:
//
//   --query contract   78 cited,   0 with code   (consumers emitted as bare paths; the edge line was discarded)
//   --query impact     27 cited,   0 with code   (`## Surface`, the "re-verify here" section, starved by the cap)
//   --format agent    249 cited,   0 with code   ("the region to read instead of a grep loop", shipping no code)
//
// So this is a GATE, not a report: a shape that goes back to bare pointers should fail loudly.
//
// THREE OUTCOMES, KEPT APART. The first version of this sweep conflated them and it mattered — passing a module
// anchor to a symbol shape made the CLI abort, the harness read the empty output as "0 citations", and a healthy
// shape looked like a defect. "Errored", "answered nothing" and "cited without showing" are three different
// states and only the last is the bug this file hunts.
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const [repo, symAnchor, moduleFile] = process.argv.slice(2);
if (!repo || !symAnchor) {
  console.error("usage: snippet-coverage.ts <repo> <file#symbol> [module-file]");
  process.exit(2);
}
const TS = join(dirname(new URL(import.meta.url).pathname), "..", "..", "ts");
const MODULE = moduleFile ?? symAnchor.split("#")[0];

// Each shape gets the anchor form it actually requires. A shape invoked with the wrong form aborts, and an
// abort is not a coverage result.
const CASES: { name: string; args: string }[] = [
  { name: "consumers",    args: `--query consumers --center ${symAnchor}` },
  { name: "dependencies", args: `--query dependencies --center ${symAnchor}` },
  { name: "writers",      args: `--query writers --center ${symAnchor}` },
  { name: "impact",       args: `--query impact --center ${symAnchor}` },
  { name: "refactor",     args: `--query refactor --center ${symAnchor}` },
  { name: "brief",        args: `--query brief --center ${symAnchor}` },
  { name: "contract",     args: `--query contract --center ${MODULE}` },
  { name: "coupling",     args: `--query coupling --anchor-file ${MODULE}` },
  { name: "agent",        args: `--auto --intent "what does this do" --center ${symAnchor} --format agent` },
];

type Run = { out: string; errored: string | null };
const run = (args: string): Run => {
  try {
    return { out: execSync(`bun src/cli/decompose.ts --scan --repo ${repo} ${args}`,
      { cwd: TS, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 }), errored: null };
  } catch (e: any) {
    const msg = String(e?.stderr ?? "").split("\n").find((l: string) => l.startsWith("error:")) ?? "non-zero exit";
    return { out: e?.stdout ?? "", errored: msg };
  }
};

// A citation is only COVERED if a gutter block follows it before the next citation — otherwise one heavily
// snippeted entry would cover for fifty bare ones. Both citation forms count: `(file.ts:42)` and the per-file
// rollup's `(:42)`, where the file is stated by the group heading (render/shapes.ts `atLine`). Missing the
// second form is what made this harness report impact at 0% when it snippets that section fully.
const measure = (out: string) => {
  let cites = 0, covered = 0, pending = false;
  for (const l of out.split("\n")) {
    if (/\([\w./@-]+\.\w{1,5}:\d+\)/.test(l) || /\(:\d+\)/.test(l)) { cites++; pending = true; continue; }
    if (/^\s+\d+\s*[│>]/.test(l) && pending) { covered++; pending = false; }
  }
  return { cites, covered };
};

console.log(`\n══════ SNIPPET COVERAGE — ${repo}`);
console.log(`   symbol anchor: ${symAnchor}   module anchor: ${MODULE}\n`);
console.log(`   shape          cited   with code   coverage`);

let bare = 0, scored = 0;
for (const c of CASES) {
  const r = run(c.args);
  if (r.errored) { console.log(`   ${c.name.padEnd(14)} — ABORTED: ${r.errored}`); continue; }
  const { cites, covered } = measure(r.out);
  if (!cites) { console.log(`   ${c.name.padEnd(14)} — answered nothing to cite (an honest negative, not a gap)`); continue; }
  scored++;
  if (!covered) bare++;
  console.log(`   ${c.name.padEnd(14)} ${String(cites).padStart(5)}   ${String(covered).padStart(9)}   `
    + `${(((covered / cites) * 100).toFixed(0) + "%").padStart(8)}${covered ? "" : "   <-- BARE POINTERS"}`);
}

if (!scored) {
  // The recurring trap here: a sweep that measured nothing reads as a clean sweep.
  console.error("\nABORT: no shape produced a citation. Bad anchors or a broken engine — NOT a coverage result.");
  process.exit(3);
}
console.log(`\n   ${scored} shape(s) scored, ${bare} citing locations with no code.`);
console.log(`   Coverage below 100% is usually the 25-citation budget cap, which the renders declare.`);
console.log(`   A shape at 0% is the defect this file hunts: pointers an agent has to dereference itself.`);
if (bare) process.exit(1);
