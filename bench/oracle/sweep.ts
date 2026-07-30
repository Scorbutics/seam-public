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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const [repo, tsconfig, limitArg] = process.argv.slice(2);
if (!repo || !tsconfig) { console.error("usage: sweep.ts <repo> <tsconfig> [limit]"); process.exit(2); }
const LIMIT = Number(limitArg ?? 25);
const HERE = dirname(new URL(import.meta.url).pathname);

const sh = (cmd: string, cwd: string, timeout = 900_000): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", timeout, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }
};
const errorsNow = (): Set<string> => {
  const out = sh(`node_modules/.bin/tsc --noEmit -p ${tsconfig}`, repo);
  const s = new Set<string>();
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): (error TS\d+)/gm)) s.add(`${m[1]}(${m[2]},${m[3]}): ${m[4]}`);
  return s;
};

/// ONLY THE ARITY ERROR COUNTS AS A CALL SITE.
///
/// The first version of this counted every fresh error, and immediately produced a FALSE ACCUSATION: it scored
/// `useSocialMediaVerification` as claimed-2-actual-4, i.e. Seam missing two call sites. It was not. There are
/// exactly two calls; breaking each one ALSO produced a downstream `TS7006 Parameter implicitly has an 'any'
/// type` where the caller destructured the now-untyped result. Two call sites, four errors.
///
/// TWO codes, and it took a second false accusation to learn why. Filtering to TS2554 alone then scored
/// `deriveMemberStatus` as claimed-3-actual-0 — Seam inventing three call sites. It had not: the function is
/// `(a, b, c?, d = …, e?)`, so it accepts 2..5 arguments and prepending a 6th REQUIRED parameter breaks no
/// arity at all. Each of the three real call sites instead reported TS2345 ("Argument of type 'boolean' is not
/// assignable to parameter of type 'number'") as its first argument slid onto the probe.
///
/// So a broken call site announces itself as EITHER:
///   TS2554 — too few arguments (the callee had no optional tail)
///   TS2345 — the first argument no longer type-checks against the probe
/// Both are the direct consequence at the call site; everything else (TS7006 and friends) is cascade downstream
/// of it and is excluded. Deduped by (file, line) so one call site counts once whichever way it complains.
///
/// TWICE NOW this harness accused the engine of a defect it did not have. Both accusations were artefacts of the
/// truth definition, and both looked entirely plausible. An oracle is only an oracle once its own failure modes
/// have been falsified — do that before believing any row it prints.
const CALL_SITE_ERROR = /error TS(2554|2345)$/;
const fileOf = (e: string) => e.slice(0, e.indexOf("(")).replace(/^\.\//, "");

if (sh("git status --porcelain", repo).split("\n").some((l) => l.trim() && !l.includes(".gitignore"))) {
  console.error("ABORT: repo has uncommitted changes beyond .gitignore — refusing to mutate");
  process.exit(2);
}

process.stderr.write("baseline compile…\n");
const BASE = errorsNow();
process.stderr.write(`baseline: ${BASE.size} pre-existing error(s)\n`);

// ── candidates: exported functions, one per (file, name) ────────────────────────────────────────────────────
const decl = sh(`rg -n --no-heading '^export (async )?function [A-Za-z_$][A-Za-z0-9_$]*\\(' -g '*.ts' -g '*.tsx' -g '!node_modules' . || true`, repo);
const candidates: { file: string; name: string }[] = [];
for (const line of decl.split("\n").filter(Boolean)) {
  const m = /^(.+?):\d+:export (?:async )?function ([A-Za-z_$][A-Za-z0-9_$]*)\(/.exec(line);
  if (m) candidates.push({ file: m[1].replace(/^\.\//, ""), name: m[2] });
}
process.stderr.write(`${candidates.length} exported function(s) found; sweeping up to ${LIMIT}\n`);

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
  const re = new RegExp(`^- ${name}\\b[^\\n]*\\n\\s+observed: (\\d+) call sites?`, "m");
  const m = re.exec(out);
  return m ? Number(m[1]) : null;
};

const rows: any[] = [];
let done = 0;
for (const c of candidates) {
  if (done >= LIMIT) break;
  const abs = join(repo, c.file);
  const original = readFileSync(abs, "utf-8");
  const re = new RegExp(`(export (?:async )?function ${c.name})\\(`);
  if (!re.test(original)) continue;

  const claim = seamClaim(c.file, c.name);
  if (claim === null) continue;          // Seam lists no consumed export by that name — no claim to score
  done++;

  let truth = 0, truthFiles = 0;
  try {
    writeFileSync(abs, original.replace(re, `$1(__oracleProbe: number, `));
    const after = errorsNow();
    const fresh = [...after].filter((e) => !BASE.has(e));
    const external = fresh.filter((e) => fileOf(e) !== c.file && CALL_SITE_ERROR.test(e));
    // one call site can emit both codes in principle; collapse to the SITE, which is the unit being counted
    const sites = new Set(external.map((e) => e.slice(0, e.lastIndexOf(","))));
    truth = sites.size;
    truthFiles = new Set(external.map(fileOf)).size;
  } finally {
    writeFileSync(abs, original);
  }
  const delta = claim - truth;
  rows.push({ file: c.file, name: c.name, claimed: claim, actual: truth, files: truthFiles, delta });
  console.log(`${delta === 0 ? "OK  " : "DIFF"} ${c.name.padEnd(28)} claimed ${String(claim).padStart(4)}  tsc ${String(truth).padStart(4)}  (${delta > 0 ? "+" : ""}${delta})  ${c.file}`);
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
