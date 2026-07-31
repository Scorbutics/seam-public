// MECHANICAL scoring for one case. No LLM judge: an LLM asked "which answer is better" carries exactly the
// bias the harness exists to control. Everything here is countable.
//
// NAMING: the arms are reported as ARM GREP / ARM SEAM, but the FILES stay `.A` / `.B`. That split is
// deliberate — the subagent writes its own answer to that path, so a file called `.seam.md` would tell it the
// run is about Seam and invite it to try harder or editorialise. The readable names are applied HERE, at
// scoring time, where no agent can see them.
//
//   bun score.ts <case-id> <ground-truth.txt> <armA.md> <armB.md> [armA.trace] [armB.trace]
//
// Ground truth is one `file#symbol` per line, established INDEPENDENTLY of either tool (tsc/LSP, or exhaustive
// manual enumeration on a small repo). Where it cannot be established honestly the case is dropped, not fudged.
import { readFileSync, existsSync } from "node:fs";

const [caseId, gtPath, aPath, bPath, aTrace, bTrace] = process.argv.slice(2);
const lines = (p: string) => readFileSync(p, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
const truth = new Set(lines(gtPath).map((l) => l.replace(/\s+#.*$/, "")));

// A tool "found" a symbol if the answer names it. Matched on the SYMBOL, not the whole file#symbol string:
// the two arms format differently and scoring formatting would measure prose style, not recall.
// TWO NUMBERS, because ONE of them measures prose style. This header already warns that scoring formatting
// would measure style rather than recall — and the file test then required the basename WITH its extension,
// which reintroduced exactly that. Run 4: arm B wrote `PartnerProgressCard,` in a comma-separated list and
// arm A wrote `components/ui/badge.tsx`, so identical knowledge scored 35% and 85%. That is the FOURTH time a
// harness in this project has falsely accused the engine, and it would have shipped as "Seam recall collapsed".
//
//   STRICT  — basename with extension (`Foo.tsx`). Rewards enumerating paths; penalises prose.
//   LENIENT — the stem too (`Foo`), word-bounded. Formatting-neutral, but a GENERIC stem (`label`, `card`) can
//             match incidental prose, so it is a ceiling, not a truth.
//
// Report both. Where they disagree the answer is a presentation difference, and neither arm "missed" anything.
const found = (text: string, lenient: boolean) => {
  const hit = new Set<string>();
  for (const t of truth) {
    const sym = t.split("#")[1] ?? t;
    const file = t.split("#")[0];
    const base = file.split("/").pop()!;
    const stem = base.replace(/\.[^.]+$/, "");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // require BOTH the symbol and its file to appear — naming `handler` alone is not locating it
    const fileNamed = text.includes(base) || (lenient && new RegExp(`\\b${esc(stem)}\\b`).test(text));
    if (new RegExp(`\\b${esc(sym)}\\b`).test(text) && fileNamed) hit.add(t);
  }
  return hit;
};

const score = (label: string, path: string, tracePath?: string) => {
  const text = readFileSync(path, "utf-8");
  const hit = found(text, false);
  const hitL = found(text, true);
  const recall = truth.size ? hit.size / truth.size : 0;
  const recallL = truth.size ? hitL.size / truth.size : 0;
  // The LENIENT set is the one to reason about when the arms format differently; the strict one is kept so a
  // regression in path-level precision is still visible.
  const missed = [...truth].filter((t) => !hitL.has(t));

  // HONESTY: of what it missed, how much did it SAY it might be missing? An undeclared miss is the expensive
  // failure for an agent — it reads as a complete answer. Counted by the missed symbol (or its file) being
  // named in an uncertainty section.
  const uncertain = (text.match(/(?:unsure|could not|couldn't|unresolved|blindspot|blind spot|may also|incomplete|not traced|opaque)[^\n]*/gi) ?? []).join("\n");
  const declared = missed.filter((m) => uncertain.includes(m.split("#")[1] ?? "") || uncertain.includes(m.split("/").pop()!.split("#")[0]));

  const tokens = Math.round(text.length / 4);          // the ANSWER an agent carries forward
  const trace = tracePath && existsSync(tracePath) ? readFileSync(tracePath, "utf-8") : "";
  const loopTokens = trace ? Math.round(trace.length / 4) : 0;   // + everything it read to get there
  const calls = trace ? (trace.match(/^\$ /gm) ?? []).length : 0;

  console.log(`\n── ${label}`);
  console.log(`   recall STRICT     ${hit.size}/${truth.size}  (${(recall * 100).toFixed(0)}%)   <- basename+ext; sensitive to prose style`);
  console.log(`   recall LENIENT    ${hitL.size}/${truth.size}  (${(recallL * 100).toFixed(0)}%)   <- stem too; formatting-neutral, the number to compare`);
  console.log(`   missed            ${missed.length}${missed.length ? ": " + missed.slice(0, 6).join(", ") : ""}`);
  console.log(`   MISSED SILENTLY   ${missed.length - declared.length}  <- the number that matters`);
  console.log(`   declared as gaps  ${declared.length}/${missed.length}`);
  console.log(`   answer tokens     ~${tokens}`);
  if (trace) console.log(`   loop tokens       ~${loopTokens}   over ${calls} tool call(s)`);
  return { label, recall: recallL, strict: recall, silent: missed.length - declared.length, tokens: tokens + loopTokens, calls };
};

console.log(`═══ ${caseId}   ground truth: ${truth.size} symbols`);
const A = score("ARM GREP", aPath, aTrace);
const B = score("ARM SEAM", bPath, bTrace);
console.log(`\n── verdict (mechanical, no judgement applied)`);
console.log(`   recall            grep ${(A.recall * 100).toFixed(0)}%  vs  seam ${(B.recall * 100).toFixed(0)}%`);
console.log(`   silent misses     grep ${A.silent}  vs  seam ${B.silent}`);
console.log(`   total tokens      grep ~${A.tokens}  vs  seam ~${B.tokens}`);
console.log(`   tool calls        grep ${A.calls}  vs  seam ${B.calls}`);
console.log(`\n   NOT scored here: whether a declared gap was ACCURATE, and which CLI levers arm B reached for.`);
console.log(`   Both are judgement and belong in the write-up, named as such.`);
