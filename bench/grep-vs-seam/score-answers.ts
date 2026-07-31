// PRECISION AND RECALL over the CANONICAL answer block. The metric `score.ts` could not honestly provide.
//
//   bun bench/grep-vs-seam/score-answers.ts <case-id>
//
// WHY A SECOND SCORER RATHER THAN AN EDIT TO score.ts. `score.ts` scores free prose, and it has been patched
// TWICE for accidentally measuring writing style instead of knowledge (run 4: identical findings scored 35% and
// 85% because one arm wrote `Foo.tsx` and the other wrote `Foo,` in a comma list). Recall survives that with a
// lenient match. PRECISION CANNOT: counting false positives from prose means counting every filename an agent
// mentions in passing as a claim, which measures verbosity. So precision is scored ONLY against the `## ANSWER`
// block that `run-arms.sh` requires from both arms in identical words — a claim is a line in that block, and
// nothing else is a claim.
//
// PRECISION IS THE POINT OF THIS CASE. `cases.json` predicts it: grep matches `cn` in strings, comments and
// other identifiers, so its false-positive rate is the thing a symbol graph should beat. A recall-only
// comparison would hide exactly the axis where the two tools differ most.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const caseId = process.argv[2];
if (!caseId) { console.error("usage: score-answers.ts <case-id>"); process.exit(2); }
const OUT = join(dirname(new URL(import.meta.url).pathname), "results");

const norm = (s: string) => s.trim().replace(/^\.\//, "").replace(/^`|`$/g, "");
const readSet = (p: string): Set<string> => {
  if (!existsSync(p)) { console.error(`ABORT: ${p} missing`); process.exit(3); }
  return new Set(readFileSync(p, "utf-8").split("\n").map(norm).filter((l) => l && !l.startsWith("#") && l.includes("#") === l.includes("#")).filter(Boolean));
};

const truth = readSet(join(OUT, `${caseId}.truth.txt`));
// Compare on FILE, not `file#symbol`: the truth files key every row to the same symbol (`…#cn`), so symbol
// matching adds nothing and only creates spurious misses when an arm writes a different but valid symbol name
// for the same location. The location is the claim.
const fileOf = (s: string) => norm(s.split("#")[0]);
const truthFiles = new Set([...truth].map(fileOf));

// A CLAIM IS A PATH, NOT A SENTENCE. Both arms wrote prose inside the `## ANSWER` block despite being told not
// to, and counting those lines as claims charged each arm a false positive for a paragraph — grep "99%" and seam
// "98%" precision were both understated by exactly the prose they wrote. That is the SAME defect this file was
// created to avoid, one level down: scoring writing rather than knowledge.
//
// So a line counts as a claim only if it LOOKS like a repo path: no whitespace, and a file extension. Everything
// else is reported separately as unparseable — visible, because an arm that cannot follow the output contract is
// a real (if different) finding, and silently dropping its prose would hide that.
const isPath = (s: string) => /^[^\s]+\.[A-Za-z0-9]{1,6}(#\S+)?$/.test(s) && !s.includes("`");

type R = { arm: string; claimed: Set<string>; tp: number; fp: string[]; fn: string[]; secs: number; calls: number; junk: number };

const scoreArm = (letter: string, label: string): R => {
  const raw = [...readSet(join(OUT, `${caseId}.${letter}.answer.txt`))];
  const paths = raw.filter(isPath);
  const junk = raw.length - paths.length;
  const claimed = new Set(paths.map(fileOf));
  const tp = [...claimed].filter((f) => truthFiles.has(f)).length;
  const fp = [...claimed].filter((f) => !truthFiles.has(f));
  const fn = [...truthFiles].filter((f) => !claimed.has(f));
  const secsP = join(OUT, `${caseId}.${letter}.secs`);
  const secs = existsSync(secsP) ? Number(readFileSync(secsP, "utf-8").trim()) : 0;
  const jsonl = join(OUT, `${caseId}.${letter}.jsonl`);
  const calls = existsSync(jsonl)
    ? (readFileSync(jsonl, "utf-8").match(/"type":"tool_use"/g) ?? []).length : 0;
  return { arm: label, claimed, tp, fp, fn, secs, calls, junk };
};

const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0) + "%" : "—");
const A = scoreArm("A", "ARM GREP"), B = scoreArm("B", "ARM SEAM");

console.log(`═══ ${caseId}   ground truth: ${truthFiles.size} file(s)\n`);
for (const r of [A, B]) {
  const prec = r.claimed.size ? r.tp / r.claimed.size : 0;
  const rec = truthFiles.size ? r.tp / truthFiles.size : 0;
  console.log(`── ${r.arm}`);
  console.log(`   claimed         ${r.claimed.size}`);
  console.log(`   precision       ${pct(r.tp, r.claimed.size)}  (${r.tp} of ${r.claimed.size} claims are real)`);
  console.log(`   recall          ${pct(r.tp, truthFiles.size)}  (${r.tp} of ${truthFiles.size} found)`);
  console.log(`   F1              ${(prec + rec ? (2 * prec * rec) / (prec + rec) * 100 : 0).toFixed(0)}%`);
  console.log(`   false positives ${r.fp.length}${r.fp.length ? ": " + r.fp.slice(0, 5).join(", ") : ""}`);
  console.log(`   missed          ${r.fn.length}${r.fn.length ? ": " + r.fn.slice(0, 5).join(", ") : ""}`);
  console.log(`   wall clock      ${r.secs}s over ${r.calls} tool call(s)`);
  console.log(`   unparseable     ${r.junk} line(s) of prose inside the ANSWER block (contract violation, not scored)\n`);
}

const f1 = (r: R) => { const p = r.claimed.size ? r.tp / r.claimed.size : 0, c = truthFiles.size ? r.tp / truthFiles.size : 0; return p + c ? (2 * p * c) / (p + c) : 0; };
console.log(`── head to head`);
console.log(`   precision   grep ${pct(A.tp, A.claimed.size)}  vs  seam ${pct(B.tp, B.claimed.size)}`);
console.log(`   recall      grep ${pct(A.tp, truthFiles.size)}  vs  seam ${pct(B.tp, truthFiles.size)}`);
console.log(`   F1          grep ${(f1(A) * 100).toFixed(0)}%  vs  seam ${(f1(B) * 100).toFixed(0)}%`);
console.log(`   wall clock  grep ${A.secs}s  vs  seam ${B.secs}s`);
console.log(`   tool calls  grep ${A.calls}  vs  seam ${B.calls}`);

// ONE RUN IS ONE SAMPLE. Both arms are LLM agents, and this project has already been burned by treating a single
// draw from a stochastic process as the system's behaviour (a cached center-first anchor read as current, and a
// consensus panel that looked fixed until it was run three times). Say it here rather than in a caveat nobody
// reads next to the number.
console.log(`\n   ONE RUN PER ARM = ONE SAMPLE of a stochastic process. A gap smaller than run-to-run variance`);
console.log(`   is not a finding. Re-run before quoting any of this; n=1 differences are anecdotes.`);
