// THE MOAT, MEASURED — `bun bench/coupling/run.ts`
//
// WHY THIS EXISTS. `bench/oracle` proved the engine correct on TS call sites, and `compare.ts` then asks the
// harder question: correct compared to WHAT. On that question the language service is a formidable arm, because
// call sites are exactly what a compiler knows. The data-coupling layer is the part of Seam that no compiler and
// no call graph has a concept of — and until now it had NO ground truth at all, which means it was a claim
// rather than a measurement. This is the smallest honest instrument for it.
//
// THREE ARMS, and two of them are here to be shown failing for a STRUCTURAL reason rather than a contingent one:
//   grep — can match a table name. Cannot tell a resolved access from prose, or one table from another's column.
//   lsp  — has no concept of a database table, an HTTP route, or an environment variable. Its honest answer is
//          NOTHING, and printing that zero is the point: it is the shape of the gap, not a defeat.
//   seam — `--query coupling`.
//
// WHAT IT MEASURES, stated narrowly on purpose: CAPABILITY (does each documented mechanism resolve at all) and
// PRECISION AGAINST THE NAME-MATCHING TRAPS (the decoys). n=4 positives cannot estimate real-world recall and
// this must never be reported as if it could. The decoys are what stop a fixture its own author wrote from being
// an advert: each one is a pair that looks coupled by name and is not.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = join(HERE, "repo");
const TS = "/home/scorbutics/seam-phase0/ts";

const sh = (cmd: string, cwd: string, timeout = 600_000): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }
};

const truth = JSON.parse(readFileSync(join(HERE, "truth.json"), "utf-8"));

// ── arm: seam ───────────────────────────────────────────────────────────────────────────────────────────────
/** `--query coupling` → the other-side FILES it resolves, and the shared keys it names. */
function seamCoupling(anchor: string): { files: Set<string>; keys: string[]; raw: string } {
  const [file, symbol] = anchor.split("#");
  const raw = sh(
    `bun src/cli/decompose.ts --repo ${REPO} --scan --query coupling --anchor-file ${file} --symbol ${symbol}`,
    TS,
  );
  // A BROKEN TOOL IS NOT A TOOL FINDING NOTHING. Without this the whole run would report a perfect zero-recall
  // "finding" when the engine simply failed to start — the exact trap that produced a 0/0 pass in the sweep.
  if (/^error:|grammars unavailable|could not be built/m.test(raw)) {
    console.error(`\nABORT: the seam CLI is not answering — the engine, not the benchmark, is broken:\n  ${raw.split("\n").find((l) => l.trim())}`);
    process.exit(3);
  }
  const files = new Set<string>();
  for (const m of raw.matchAll(/^\s+[←→]\s+\S+\s+\((.+?):\d+\)/gm)) files.add(m[1]);
  const keys = [...raw.matchAll(/^## \S+ "(.+?)"/gm)].map((m) => m[1]);
  return { files, keys, raw };
}

// ── arm: grep ───────────────────────────────────────────────────────────────────────────────────────────────
/** The best a name search can do: every file mentioning the key, minus the anchor's own file. */
function grepKey(key: string, anchorFile: string): Set<string> {
  const needle = key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const out = sh(`rg -l '${needle}' -g '!node_modules' . || true`, REPO);
  const files = new Set<string>();
  for (const l of out.split("\n").filter(Boolean)) {
    const f = l.replace(/^\.\//, "");
    if (f !== anchorFile) files.add(f);
  }
  return files;
}

// ── arm: lsp ────────────────────────────────────────────────────────────────────────────────────────────────
// Deliberately NOT implemented, and that is the measurement. A language service resolves identifiers within one
// language's program. A table name in a SQL string, a route literal in an annotation, and an environment
// variable are all opaque strings to it — there is no request to send. Reporting this as an empty answer would
// imply it tried and found nothing; the honest report is that the question is outside its model.
const LSP_ANSWER = "outside its model: no reference request exists for a table, a route, or an env key";

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────
const rows: any[] = [];

console.log("══ POSITIVES — does each documented mechanism resolve at all?\n");
for (const p of truth.positives) {
  const seam = seamCoupling(p.anchor);
  const found = p.expectOtherSide.filter((f: string) => seam.files.has(f));
  const missed = p.expectOtherSide.filter((f: string) => !seam.files.has(f));
  const grep = grepKey(p.key, p.anchor.split("#")[0]);
  const grepFound = p.expectOtherSide.filter((f: string) => grep.has(f));
  rows.push({ kind: "positive", id: p.id, expected: p.expectOtherSide.length, seamFound: found.length, grepFound: grepFound.length, grepNoise: grep.size - grepFound.length, missed, keys: seam.keys, knownGap: p.knownGap ?? null });
  // A DECLARED GAP still prints as a miss -- it is one -- but does not fail the run, so the instrument stays
  // green-when-healthy and a NEW miss is unmistakable. Softening it to PASS would hide the thing it found.
  console.log(`${missed.length === 0 ? "PASS" : p.knownGap ? "GAP " : "FAIL"} ${p.id}${p.knownGap ? `  — DECLARED: ${p.knownGap}` : ""}`);
  console.log(`     key ${JSON.stringify(p.key)}${seam.keys.length ? `   seam named: ${seam.keys.map((k) => JSON.stringify(k)).join(", ")}` : "   seam named: (none)"}`);
  console.log(`     seam  ${found.length}/${p.expectOtherSide.length} other side${missed.length ? `   MISSED ${missed.join(", ")}` : ""}`);
  console.log(`     grep  ${grepFound.length}/${p.expectOtherSide.length} other side, plus ${grep.size - grepFound.length} file(s) that merely mention the key`);
  console.log(`     lsp   ${LSP_ANSWER}\n`);
}

console.log("\n══ DECOYS — the name-matching traps. A hit here is a FALSE DISCOVERY.\n");
for (const d of truth.decoys) {
  const seam = seamCoupling(d.anchor);
  const hits = d.mustNotContain.filter((f: string) => seam.files.has(f));
  // A DECOY THAT PASSES BECAUSE NOTHING WAS RESOLVED PROVES NOTHING. If the anchor named no shared key at all,
  // "correctly absent" is indistinguishable from "the layer saw nothing here" — the null-answer trap that let a
  // whole shape sit outside the CLI gate while its case looked covered. Verified non-vacuous, not assumed:
  // closeWorkOrder must actually resolve `work_orders`, and writeAudit must actually resolve `audit_log`.
  const vacuous = seam.keys.length === 0 && !/shared keys: [1-9]/.test(seam.raw);
  const grepHits = d.mustNotContain.filter((f: string) => {
    // the decoy's trap key is whatever the anchor touches; grep is given the benefit of the doubt and asked
    // about every key seam named, plus the bare column/table word the decoy shares
    return seam.keys.some((k) => grepKey(k, d.anchor.split("#")[0]).has(f));
  });
  rows.push({ kind: "decoy", id: d.id, seamFalse: hits.length, grepFalse: grepHits.length, vacuous });
  console.log(`${vacuous ? "INCONCLUSIVE" : hits.length === 0 ? "PASS" : "FAIL"} ${d.id}${vacuous ? "  — the anchor resolved NO key, so absence proves nothing" : ""}`);
  console.log(`     seam  ${hits.length ? `FALSE POSITIVE: ${hits.join(", ")}` : "correctly absent"}`);
  console.log(`     grep  ${grepHits.length ? `false positive: ${grepHits.join(", ")}` : "correctly absent"}`);
  console.log(`     why   ${d.why}\n`);
}

const pos = rows.filter((r) => r.kind === "positive");
const dec = rows.filter((r) => r.kind === "decoy");
const seamRecall = pos.reduce((s, r) => s + r.seamFound, 0);
const seamTotal = pos.reduce((s, r) => s + r.expected, 0);
const grepRecall = pos.reduce((s, r) => s + r.grepFound, 0);
const grepNoise = pos.reduce((s, r) => s + r.grepNoise, 0);

console.log("══════ SUMMARY");
console.log(`   mechanisms resolved   seam ${seamRecall}/${seamTotal}   grep ${grepRecall}/${seamTotal}   lsp 0/${seamTotal} (structurally)`);
console.log(`   false discoveries     seam ${dec.reduce((s, r) => s + r.seamFalse, 0)}/${dec.length} decoys   grep ${dec.reduce((s, r) => s + r.grepFalse, 0)}/${dec.length} decoys`);
console.log(`   grep noise on the positives: ${grepNoise} file(s) that mention a key without accessing it`);
console.log(`\n   SCOPE: capability + precision against the traps. n=${seamTotal} positives is NOT a recall rate — see truth.json.`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "coupling.json"), JSON.stringify(rows, null, 2));
const knownGaps = pos.filter((r) => r.missed.length && r.knownGap).length;
if (knownGaps) console.log(`   ${knownGaps} declared gap(s) among the misses — see truth.json; they do not fail the run, a NEW miss does.`);
const inconclusive = dec.filter((r) => r.vacuous).length;
if (inconclusive) console.log(`   ${inconclusive} decoy(s) INCONCLUSIVE — the anchor resolved no key, so their absence is not evidence.`);
const failed = pos.filter((r) => r.missed.length && !r.knownGap).length + dec.filter((r) => r.seamFalse || r.vacuous).length;
process.exit(failed ? 1 : 0);
