// MECHANICAL scoring for one case. No LLM judge: an LLM asked "which answer is better" carries exactly the
// bias the harness exists to control. Everything here is countable.
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
const found = (text: string) => {
  const hit = new Set<string>();
  for (const t of truth) {
    const sym = t.split("#")[1] ?? t;
    const file = t.split("#")[0];
    // require BOTH the symbol and its file to appear — naming `handler` alone is not locating it
    if (new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)
        && text.includes(file.split("/").pop()!)) hit.add(t);
  }
  return hit;
};

const score = (label: string, path: string, tracePath?: string) => {
  const text = readFileSync(path, "utf-8");
  const hit = found(text);
  const recall = truth.size ? hit.size / truth.size : 0;
  const missed = [...truth].filter((t) => !hit.has(t));

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
  console.log(`   recall            ${hit.size}/${truth.size}  (${(recall * 100).toFixed(0)}%)`);
  console.log(`   missed            ${missed.length}${missed.length ? ": " + missed.slice(0, 6).join(", ") : ""}`);
  console.log(`   MISSED SILENTLY   ${missed.length - declared.length}  <- the number that matters`);
  console.log(`   declared as gaps  ${declared.length}/${missed.length}`);
  console.log(`   answer tokens     ~${tokens}`);
  if (trace) console.log(`   loop tokens       ~${loopTokens}   over ${calls} tool call(s)`);
  return { label, recall, silent: missed.length - declared.length, tokens: tokens + loopTokens, calls };
};

console.log(`═══ ${caseId}   ground truth: ${truth.size} symbols`);
const A = score("ARM A (grep/rg)", aPath, aTrace);
const B = score("ARM B (seam)", bPath, bTrace);
console.log(`\n── verdict (mechanical, no judgement applied)`);
console.log(`   recall            A ${(A.recall * 100).toFixed(0)}%  vs  B ${(B.recall * 100).toFixed(0)}%`);
console.log(`   silent misses     A ${A.silent}  vs  B ${B.silent}`);
console.log(`   total tokens      A ~${A.tokens}  vs  B ~${B.tokens}`);
console.log(`   tool calls        A ${A.calls}  vs  B ${B.calls}`);
console.log(`\n   NOT scored here: whether a declared gap was ACCURATE, and which CLI levers arm B reached for.`);
console.log(`   Both are judgement and belong in the write-up, named as such.`);
