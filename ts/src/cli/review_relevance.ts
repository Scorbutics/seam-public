// LAYER 1 — the deterministic RELEVANCE FLOOR for review-impact flags. The fatigue-killer: a change that
// touches a shared contract is only relevant to a consumer if it touched the PART the consumer uses. We
// prove that structurally — the fields a change WRITES (on its added lines) ∩ the fields the consumer
// READS — and SUPPRESS ONLY ON PROOF of non-overlap. Anything we can't pin (whole-row `select('*')`,
// dynamic access, no extractable write) stays `unknown` for layer 3 / the human. Recall-safe by design:
// `irrelevant` requires BOTH sides pinned AND disjoint; uncertainty never suppresses.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Relevance = "relevant" | "unknown" | "irrelevant";

// Fields a change WRITES, from its ADDED lines only: assignment targets (`const fee =`, `x =`,
// `obj.fee =` → fee) + object-literal keys in a write call (`.insert({ fee })`). NOT RHS reads — only the
// written contract. (Added-lines-only is why an unchanged `insert({amount,fee})` context line doesn't leak.)
const _ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])|\.([A-Za-z_$][\w$]*)\s*=(?![=>])|(?:^|[^.\w])([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
const _WRITE_OBJ = /\.(?:insert|update|set|create|save|put)\s*\(\s*\{([^}]*)\}/g;
export function writtenFields(addedLines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of addedLines) {
    for (const m of line.matchAll(_ASSIGN)) { const n = m[1] ?? m[2] ?? m[3]; if (n) out.add(n); }
    for (const m of line.matchAll(_WRITE_OBJ)) for (const k of m[1].split(",")) {
      const key = k.split(":")[0].trim().replace(/['"]/g, ""); if (/^[A-Za-z_$][\w$]*$/.test(key)) out.add(key);
    }
  }
  return out;
}

// Fields a consumer READS + whether it reads the WHOLE object (so we CANNOT prove irrelevance):
// `.select('a','b')` columns + member reads `x.foo`. `select('*')`/`select()`/spread/serialize → wholeObject.
const _SELECT = /\.select\s*\(\s*([^)]*)\)/g;
const _MEMBER_READ = /[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g;
export function readFields(text: string): { fields: Set<string>; wholeObject: boolean } {
  const fields = new Set<string>();
  let wholeObject = false;
  for (const m of text.matchAll(_SELECT)) {
    const arg = m[1].trim();
    if (!arg || arg.includes("*")) { wholeObject = true; continue; }
    for (const c of arg.split(",")) { const col = c.trim().replace(/['"]/g, ""); if (/^[A-Za-z_$][\w$]*$/.test(col)) fields.add(col); }
  }
  if (/\.\.\.|JSON\.stringify|Object\.(keys|values|entries)/.test(text)) wholeObject = true;   // spread / serialize = uses everything
  for (const m of text.matchAll(_MEMBER_READ)) fields.add(m[1]);
  return { fields, wholeObject };
}

// The floor verdict for one (change, consumer) pair. relevant = change wrote a field the consumer reads;
// irrelevant = both sides pinned and disjoint (PROVEN unrelated); unknown = can't pin either side.
export function scoreRelevance(addedLines: string[], consumerFile: string, repo: string): Relevance {
  const wf = writtenFields(addedLines);
  if (!wf.size) return "unknown";                       // couldn't pin what the change wrote
  let text: string;
  try { text = readFileSync(join(repo, consumerFile), "utf-8"); } catch { return "unknown"; }
  const { fields, wholeObject } = readFields(text);
  if (wholeObject || !fields.size) return "unknown";    // reader uses the whole object / nothing pinnable
  for (const f of wf) if (fields.has(f)) return "relevant";
  return "irrelevant";                                  // both pinned, disjoint → proven unrelated
}

// AST-first relevance — same verdict semantics as `scoreRelevance`, but the written/read field sets come
// from tree-sitter (cross-language: JS/TS/Java/Ruby/C/C++) via field_facts, with the regex floor as the
// fallback when no grammar/parse is available. This is the floor's MOAT.md Gap-1 hardening: the hero
// cross-stack case (a JS change ↔ a Java reader, or vice-versa) now resolves fields on BOTH sides.
// `key` (optional) = the shared table/route the cross-stack edge is on; when given, the read side binds
// to fields read off THAT key's data (Gap 2 — drops unrelated same-named reads elsewhere in the file).
export async function scoreRelevanceAst(repo: string, changedFile: string, changedLines: Set<number>,
    addedLines: string[], consumerFile: string, key?: string): Promise<Relevance> {
  const { readFieldsOf, writtenFieldsOf } = await import("./field_facts.js");
  const wf = (await writtenFieldsOf(repo, changedFile, changedLines)) ?? writtenFields(addedLines);
  if (!wf.size) return "unknown";                       // couldn't pin what the change wrote
  let fields: Set<string>, wholeObject: boolean;
  const rf = await readFieldsOf(repo, consumerFile, key);
  if (rf) ({ fields, wholeObject } = rf);
  else {                                                 // no grammar/parse → regex floor over the file text
    let text: string; try { text = readFileSync(join(repo, consumerFile), "utf-8"); } catch { return "unknown"; }
    ({ fields, wholeObject } = readFields(text));
  }
  if (wholeObject || !fields.size) return "unknown";    // reader uses the whole object / nothing pinnable
  for (const f of wf) if (fields.has(f)) return "relevant";
  return "irrelevant";                                  // both pinned, disjoint → proven unrelated
}

// External (transitive consumer) relevance is coarser: a transitive caller is affected when the change
// alters the symbol's CONTRACT (its declaration/signature among the added lines) — else `unknown` (a
// body/behaviour change *might* matter, so never `irrelevant`).
const sigRe = (sym: string) => new RegExp(`(?:function|def|class|interface|const|let|var)\\s+${sym}\\b|\\b${sym}\\s*[:=]?\\s*(?:async\\s*)?\\(`);
export function externalRelevance(addedLines: string[], symbol: string): Relevance {
  const re = sigRe(symbol);
  return addedLines.some((l) => re.test(l)) ? "relevant" : "unknown";
}
