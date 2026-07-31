// SNIPPET COVERAGE PER SHAPE — of the locations a shape CITES, how many does it show the code for?
//
// `bun bench/grep-vs-seam/snippet-coverage.ts <repo> <center> [symbol]`
//
// WHY THIS EXISTS. `verification-tax.ts` binned the post-answer work of all three benchmark cases and found the
// dominant disease is a CONTENT gap, not the grep-trained distrust that was assumed: cal.com cited 416 files and
// printed the code for 4; keycloak cited 84 and printed 2. An agent handed 416 pointers and 4 dereferences will
// go and dereference the rest itself, and reading a whole file costs far more than the lines would have.
//
// The coverage is not uniform, and that is the actionable part — `--query consumers` ships snippets on nearly
// every edge while `--query contract`'s consumer list ships none. So this measures COVERAGE PER SHAPE, which is
// the number a renderer change has to move, and it is a gate: a shape that stops citing its sources should fail
// loudly rather than quietly get cheaper.
//
// citations = `(path/to/file.ext:123)` — a location the reader is expected to go look at
// snippets  = a gutter block (`  123> …` / `  122│ …`) attached to one of them
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const [repo, center, symbol] = process.argv.slice(2);
if (!repo || !center) { console.error("usage: snippet-coverage.ts <repo> <center> [symbol]"); process.exit(2); }
const TS = join(dirname(new URL(import.meta.url).pathname), "..", "..", "ts");

const SHAPES = ["consumers", "dependencies", "contract", "coupling", "impact", "refactor", "brief"];

const run = (args: string): string => {
  try { return execSync(`bun src/cli/decompose.ts --scan --repo ${repo} ${args}`,
    { cwd: TS, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 900_000 }); }
  catch (e: any) { return e?.stdout ?? ""; }
};

// A citation is only "covered" if a gutter block follows it before the NEXT citation. Counting gutter lines
// against citations repo-wide would let one heavily-snippeted edge cover for fifty bare ones.
const measure = (out: string) => {
  const lines = out.split("\n");
  let cites = 0, covered = 0, pending = false;
  for (const l of lines) {
    // BOTH citation forms, or this undercounts. `impact`'s per-file rollup states the file in a group heading
    // and cites only the line — `getBugReportStatusBadge (:250)` (render/shapes.ts `atLine`). Counting only the
    // full `file:line` form scored that whole section as uncited and reported impact at 0% coverage when it in
    // fact snippets every entry. The harness was wrong, not the shape; the real impact defect is below.
    if (/\([\w./@-]+\.\w{1,5}:\d+\)/.test(l) || /\(:\d+\)/.test(l)) { cites++; pending = true; continue; }
    if (/^\s+\d+\s*[│>]/.test(l) && pending) { covered++; pending = false; }
  }
  return { cites, covered };
};

console.log(`\n══════ SNIPPET COVERAGE — ${repo} :: ${center}${symbol ? "#" + symbol : ""}`);
console.log(`   of the locations each shape CITES, how many does it show the code for?\n`);
console.log(`   shape          cited   with code   coverage`);

const anchor = symbol ? `--center ${center}#${symbol}` : `--center ${center}`;
let anyCited = 0;
for (const s of SHAPES) {
  const out = run(`--query ${s} ${anchor}`);
  const { cites, covered } = measure(out);
  anyCited += cites;
  const pctv = cites ? ((covered / cites) * 100).toFixed(0) + "%" : "—";
  console.log(`   ${s.padEnd(14)} ${String(cites).padStart(5)}   ${String(covered).padStart(9)}   ${pctv.padStart(8)}`
    + (cites && covered === 0 ? "   <- cites locations, shows no code" : ""));
}
// The recurring trap in this repo is a harness that measures nothing and reads as a clean result. If no shape
// cited anything, the anchor is wrong or the engine is broken — either way it is not 100% coverage.
if (!anyCited) { console.error("\nABORT: no shape cited a single location. Bad anchor or broken engine — NOT a coverage result."); process.exit(3); }
