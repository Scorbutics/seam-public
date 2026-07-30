// THE SWEEP — the oracle at scale. `bun bench/oracle/sweep.ts <repo> <tsconfig> [limit]`
//
// One hand-written case proves the method; it does not measure the engine. The oracle's whole point was that n
// is the number of CALL SITES in a repo rather than the number of cases anyone can afford to write, and this is
// what cashes that in: it generates its own cases, one per exported function, and scores them all against `tsc`.
//
// THE MUTATION, and why it is this one. Prepend a required parameter to the declaration:
//
//     export function foo(a: string)  ->  export function foo(__oracleProbe: number, a: string)
//
// Every call site now fails to compile — wrong arity, and wrong type in the first position. So `tsc`'s error set
// IS the complete call-site set, which is precisely the number `--query contract` claims in its `observed:`
// line. The comparison is therefore direct and falsifiable, symbol by symbol, with no judgement anywhere.
//
// Prepending (not appending) so that variadic and defaulted signatures work too: `...rest` must stay last, and
// an appended param after a default is legal but does not force an arity error at existing call sites.
//
// COUNTING CONTRACT, matched deliberately to the shape under test: `--query contract` counts call sites in
// EXTERNAL consumer files only, so errors inside the defining file are excluded here as well. Comparing against
// a total that included same-file calls would manufacture a disagreement that is really a grain mismatch — the
// exact confusion that produced the 247-vs-313 bug.
//
// The baseline compile is run ONCE for the repo, not once per symbol (9.7s each on private-app; 30 symbols would
// otherwise waste five minutes proving the repo still has its 23 pre-existing errors).
//
// THE PROBE ITSELF LIVES IN `probe.ts`, shared with `compare.ts`. It used to live here, and two harnesses with
// two copies of their own truth definition is one that eventually disagrees with itself and blames the tool.
// Every false-accusation comment that justified the TS2554/TS2345 rule moved there with it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { openProbe, sh } from "./probe.ts";

const [repo, tsconfig, limitArg] = process.argv.slice(2);
if (!repo || !tsconfig) { console.error("usage: sweep.ts <repo> <tsconfig> [limit]"); process.exit(2); }
const LIMIT = Number(limitArg ?? 25);
const HERE = dirname(new URL(import.meta.url).pathname);

const probe = openProbe(repo, tsconfig);
process.stderr.write(`sweeping up to ${LIMIT}\n`);

// contract is per FILE and lists every export, so cache it rather than re-running per symbol
const SEAM = "cd /home/scorbutics/seam-phase0/ts && bun src/cli/decompose.ts";
const contractCache = new Map<string, string>();
const contractOf = (file: string): string => {
  if (!contractCache.has(file))
    contractCache.set(file, sh(`${SEAM} --scan --repo ${repo} --query contract --center ${file} --format llm-context`, "/"));
  return contractCache.get(file)!;
};
/** Seam's claimed call-site count for `name`, or null when it makes no claim (not a listed export). */
const seamClaim = (file: string, name: string): number | null => {
  const out = contractOf(file);
  // A BROKEN TOOL IS NOT A TOOL MAKING NO CLAIM. This distinction cost a whole run: `git checkout` had deleted
  // ts/node_modules, so every seam invocation died with "tree-sitter grammars unavailable" — the engine failing
  // LOUDLY, exactly as designed — and this function read the absence of a claim and returned null for all 200
  // candidates. The sweep then printed "0 symbols swept, EXACT 0/0" and exited 0, as if that were a clean
  // result. A harness that reports success when the thing under test never ran is worse than no harness.
  if (/^error:|grammars unavailable|could not be built/m.test(out)) {
    console.error(`\nABORT: the seam CLI is not answering — the engine, not the benchmark, is broken:\n  ${out.split("\n").find((l) => l.trim()) ?? "(no output)"}`);
    process.exit(3);
  }
  const re = new RegExp(`^- ${name}\\b[^\\n]*\\n\\s+observed: (\\d+) call sites?`, "m");
  const m = re.exec(out);
  return m ? Number(m[1]) : null;
};

const rows: any[] = [];
let done = 0;
for (const c of probe.candidates) {
  if (done >= LIMIT) break;
  const claim = seamClaim(c.file, c.name);
  if (claim === null) continue;          // Seam lists no consumed export by that name — no claim to score

  const truth = probe.truthFor(c.file, c.name);
  if (!truth) continue;                  // the declaration is not where the candidate scan said it was
  done++;

  const delta = claim - truth.sites.size;
  rows.push({ file: c.file, name: c.name, claimed: claim, actual: truth.sites.size, files: truth.files.size, delta });
  console.log(`${delta === 0 ? "OK  " : "DIFF"} ${c.name.padEnd(28)} claimed ${String(claim).padStart(4)}  tsc ${String(truth.sites.size).padStart(4)}  (${delta > 0 ? "+" : ""}${delta})  ${c.file}`);
}

// Nothing scored means the run proved nothing. Say so and FAIL, rather than printing a 0/0 that reads as a pass.
if (rows.length === 0) {
  console.error("ABORT: 0 symbols scored. Either no candidate is a consumed export, or the tool made no claims. Not a result.");
  process.exit(3);
}
const exact = rows.filter((r) => r.delta === 0).length;
const over = rows.filter((r) => r.delta > 0);
const under = rows.filter((r) => r.delta < 0);
console.log(`\n══ ${rows.length} symbol(s) swept`);
console.log(`   EXACT             ${exact}/${rows.length}  (${rows.length ? ((exact / rows.length) * 100).toFixed(0) : 0}%)`);
console.log(`   over-claimed      ${over.length}${over.length ? `  (worst +${Math.max(...over.map((r) => r.delta))})` : ""}   <- Seam says MORE sites than exist`);
console.log(`   under-claimed     ${under.length}${under.length ? `  (worst ${Math.min(...under.map((r) => r.delta))})` : ""}   <- Seam MISSES sites; the expensive direction`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "sweep.json"), JSON.stringify({ repo, swept: rows.length, exact, rows }, null, 2));
const dirty = sh("git status --porcelain", repo).split("\n").filter((l) => l.trim() && !l.includes(".gitignore"));
if (dirty.length) console.error(`\nWARNING: repo dirty after sweep: ${dirty.join(" ")}`);
else console.log(`\n   repo clean after sweep ✓`);
