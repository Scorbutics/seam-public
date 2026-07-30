// THREE ARMS, ONE JUDGE — `bun bench/oracle/compare.ts <repo> <tsconfig> [limit]`
//
// WHY THIS EXISTS, on top of `sweep.ts`. The sweep answers "is Seam correct?" and answers it well: 195/200 exact
// against `tsc` at n=200. What it cannot answer is the question that actually decides where the work goes —
// **correct compared to what?** A tool that is 98% right at something `rg` also gets right, or that a language
// server gets right in 40ms, has proven its correctness and not its value.
//
// So the same probe now scores THREE arms on the identical question ("how many places call this, and where"):
//
//   grep — the floor. Line-grained, no resolution. Included because it is what agents actually reach for.
//   lsp  — the TypeScript LANGUAGE SERVICE, the same `findReferences` an editor runs. THE ARM THAT CAN KILL THE
//          CLAIM, and the reason this file exists: beating naked `rg` on a TypeScript monorepo proves nothing,
//          because any competent agent can reach the compiler. If the language service is exact and cheap, then
//          on TS call-site questions Seam's value is NOT capability — it is cost, cross-language reach, and
//          questions an LSP has no concept of. That is a finding, not a failure, and it is unobtainable without
//          building the arm that might win.
//   seam — `--query contract`'s `observed: N call sites`.
//
// COST IS MEASURED HONESTLY. The language service's program build is ~3s on private-app and dominates any single query,
// so asking one symbol per process would report a price no real user pays — an editor keeps the program warm.
// The build is timed ONCE and reported separately from the per-symbol cost. Seam is cached per module file for
// the same reason (one `contract` call answers every export of that file), and its per-file cost is reported.
//
// STRATIFIED, because an aggregate hides the answer. The sweep's four residual misses were ALL barrel-reached,
// which the aggregate "195/200" never showed. Every row is labelled by the mechanism standing between the
// declaration and its callers, and the summary is per stratum.
//
// The stratum label is NAME-BASED and therefore approximate: two modules exporting the same name can mislabel a
// row. It steers attention, it is not evidence — the score in that row is what is evidence.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { openProbe, sh } from "./probe.ts";
import { armSeam, armGrep, armLspBatch, seamFirstCallMs, type Answer } from "./arms.ts";

const [repo, tsconfig, limitArg] = process.argv.slice(2);
if (!repo || !tsconfig) { console.error("usage: compare.ts <repo> <tsconfig> [limit]"); process.exit(2); }
const LIMIT = Number(limitArg ?? 40);
const HERE = dirname(new URL(import.meta.url).pathname);

const probe = openProbe(repo, tsconfig);

// ── strata: what stands between the declaration and its callers ──────────────────────────────────────────────
//
// WHOLE FILES, not rg lines. The first version matched `export {…} from` against one rg output line at a time and
// therefore could not see a MULTI-LINE export block — which is the common formatting, and which is exactly how
// private-app writes its aliasing barrel:
//
//     export {
//       computeWeekAnchor as getWeekStartForPreference,
//
// So it reported `plain=748 barrel=5` and NO alias stratum at all, on a repo whose only known aliasing barrel is
// the one that produced the 15-vs-19 undercount this whole change came from. The label was blind to the mechanism
// it exists to label.
// String.raw, because in a plain template literal `\s` and `\*` are escape sequences: the shell received
// `exports*(*|{)` and rg matched 0 files, so the whole re-export scan reported "0 named forward(s) across 0
// file(s)" and every candidate fell into `plain`. VERIFY A PATTERN BY RUNNING IT, not by reading it -- the same
// lesson the `rg -o 'cn('` verify-hint bug taught (there, `\b` in a template literal was a BACKSPACE).
const barrelFiles = sh(String.raw`rg -l --sort path 'export\s*(\*|\{)' -g '*.ts' -g '*.tsx' -g '!node_modules' . || true`, repo)
  .split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean);
const namedReexport = new Map<string, "barrel" | "alias">();
const starExportedModules: string[] = [];
for (const f of barrelFiles) {
  let text: string;
  try { text = readFileSync(join(repo, f), "utf-8"); } catch { continue; }
  for (const m of text.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) starExportedModules.push(m[1]);
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const [orig, alias] = p.split(/\s+as\s+/).map((x) => x.trim());
      // an ALIAS is the harder case and must not be overwritten by a plain forward of the same name elsewhere
      if (alias && alias !== orig) namedReexport.set(orig, "alias");
      else if (!namedReexport.has(orig)) namedReexport.set(orig, "barrel");
    }
  }
}
const starExported = new Set(starExportedModules.map((s) => s.replace(/^.*\//, "")));
const stratumOf = (c: { file: string; name: string }): string =>
  namedReexport.get(c.name) ?? (starExported.has(c.file.replace(/^.*\//, "").replace(/\.tsx?$/, "")) ? "barrel" : "plain");

process.stderr.write(`re-export scan: ${namedReexport.size} named forward(s) across ${barrelFiles.length} file(s), ${starExportedModules.length} star barrel(s)\n`);

// ── pick the rows: candidates Seam makes a claim about, so every arm answers the same question ────────────────
//
// STRATIFIED, and it has to be. The first run took the first LIMIT candidates in path order and drew all 40 from
// the `plain` stratum, so the per-stratum table was a verbatim copy of the aggregate — a breakdown that reads as
// coverage of three mechanisms while measuring one. The barrel and alias strata are the interesting ones (every
// residual miss the sweep ever had was barrel-reached) and they are also the RARE ones, so a head-of-list sample
// will essentially never contain them. Buckets are filled round-robin instead.
const buckets = new Map<string, { file: string; name: string }[]>();
for (const c of probe.candidates) {
  const s = stratumOf(c);
  if (!buckets.has(s)) buckets.set(s, []);
  buckets.get(s)!.push(c);
}
process.stderr.write(`strata available: ${[...buckets].map(([k, v]) => `${k}=${v.length}`).join(" ")}\n`);
const targets: { file: string; name: string }[] = [];
const order = [...buckets.keys()].sort();
for (let i = 0; targets.length < LIMIT; i++) {
  let advanced = false;
  for (const s of order) {
    const list = buckets.get(s)!;
    if (i >= list.length) continue;
    advanced = true;
    if (targets.length >= LIMIT) break;
    const c = list[i];
    const a = armSeam(repo, c.file, c.name);
    if (a.callSites === null) continue;  // not a consumed export — no claim to score, for any arm
    targets.push(c);
  }
  if (!advanced) break;                  // every bucket exhausted
}
if (!targets.length) { console.error("ABORT: no candidate is a consumed export. Not a result."); process.exit(3); }
process.stderr.write(`${targets.length} target(s) selected\n`);

// seam's cost, measured per MODULE FILE (one contract call answers every export in it)
// The FIRST call's cost, recorded when it happened during selection above — NOT re-timed here, which would
// measure a cache hit and report 0ms for the tool under test.
const seamFileMs = new Map<string, number>();
for (const t of new Set(targets.map((x) => x.file))) seamFileMs.set(t, seamFirstCallMs(repo, t));

process.stderr.write("lsp arm (one program build, then per symbol)…\n");
const { answers: lspAnswers, buildMs: lspBuildMs } = armLspBatch(repo, tsconfig, targets);

// ── score ────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = {
  file: string; name: string; stratum: string;
  truth: number; truthFiles: number;
  arms: Record<string, { claim: number | null; delta: number | null; fileRecall: number; extraFiles: number; ms: number }>;
};
const rows: Row[] = [];

for (const t of targets) {
  const truth = probe.truthFor(t.file, t.name);
  if (!truth) continue;
  const key = `${t.file}#${t.name}`;
  const answers: Record<string, Answer> = {
    grep: armGrep(repo, t.file, t.name),
    lsp: lspAnswers.get(key) ?? { arm: "lsp", callSites: null, files: new Set(), ms: 0, note: "no answer" },
    seam: armSeam(repo, t.file, t.name),
  };
  const arms: Row["arms"] = {};
  for (const [name, a] of Object.entries(answers)) {
    const missed = [...truth.files].filter((f) => !a.files.has(f));
    arms[name] = {
      claim: a.callSites,
      delta: a.callSites === null ? null : a.callSites - truth.sites.size,
      fileRecall: truth.files.size ? +(((truth.files.size - missed.length) / truth.files.size) * 100).toFixed(1) : 100,
      extraFiles: [...a.files].filter((f) => !truth.files.has(f)).length,
      ms: name === "seam" ? (seamFileMs.get(t.file) ?? 0) : a.ms,
    };
  }
  const row: Row = { file: t.file, name: t.name, stratum: stratumOf(t), truth: truth.sites.size, truthFiles: truth.files.size, arms };
  rows.push(row);
  const cell = (n: string) => {
    const a = row.arms[n];
    return `${n}:${String(a.claim ?? "—").padStart(4)}${a.delta === 0 ? " ✓" : a.delta === null ? " ?" : ` ${a.delta > 0 ? "+" : ""}${a.delta}`.padEnd(4)}`;
  };
  console.log(`${row.stratum.padEnd(6)} ${row.name.padEnd(30)} tsc ${String(row.truth).padStart(4)}   ${cell("grep")}  ${cell("lsp")}  ${cell("seam")}`);
}

if (!rows.length) { console.error("ABORT: 0 rows scored. Not a result."); process.exit(3); }

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────
const ARMS = ["grep", "lsp", "seam"];
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0) : "0");
const summarise = (subset: Row[], label: string) => {
  console.log(`\n── ${label}  (n=${subset.length})`);
  for (const a of ARMS) {
    const cells = subset.map((r) => r.arms[a]);
    const scored = cells.filter((c) => c.delta !== null);
    const exact = scored.filter((c) => c.delta === 0).length;
    const under = scored.filter((c) => (c.delta ?? 0) < 0).length;
    const over = scored.filter((c) => (c.delta ?? 0) > 0).length;
    const recall = subset.length ? (subset.reduce((s, r) => s + r.arms[a].fileRecall, 0) / subset.length).toFixed(1) : "—";
    const extra = cells.reduce((s, c) => s + c.extraFiles, 0);
    console.log(`   ${a.padEnd(5)} exact ${String(exact).padStart(3)}/${String(scored.length).padEnd(3)} (${pct(exact, scored.length).padStart(3)}%)   under ${String(under).padStart(3)}  over ${String(over).padStart(3)}   file-recall ${recall.padStart(5)}%   false files ${String(extra).padStart(4)}   no-claim ${cells.length - scored.length}`);
  }
};
console.log(`\n══════ ${rows.length} symbol(s), judged by tsc`);
summarise(rows, "ALL");
for (const s of [...new Set(rows.map((r) => r.stratum))].sort()) summarise(rows.filter((r) => r.stratum === s), `stratum: ${s}`);

// COST. Reported as two numbers per arm because they are paid at different times, and collapsing them into a
// per-query average is how a warm-program tool gets slandered (or flattered).
const sumMs = (a: string) => rows.reduce((s, r) => s + r.arms[a].ms, 0);
console.log(`\n── cost`);
console.log(`   grep  ${(sumMs("grep") / rows.length).toFixed(0)}ms per symbol, no setup`);
console.log(`   lsp   ${lspBuildMs}ms ONE-OFF program build, then ${(sumMs("lsp") / rows.length).toFixed(0)}ms per symbol`);
console.log(`   seam  ${(sumMs("seam") / new Set(rows.map((r) => r.file)).size).toFixed(0)}ms per MODULE FILE (one call answers every export in it), ${new Set(rows.map((r) => r.file)).size} file(s)`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "compare.json"), JSON.stringify({ repo, rows, lspBuildMs }, null, 2));
const dirty = sh("git status --porcelain", repo).split("\n").filter((l) => l.trim() && !l.includes(".gitignore"));
if (dirty.length) console.error(`\nWARNING: repo dirty after run: ${dirty.join(" ")}`);
else console.log(`\n   repo clean after run ✓`);
