// #5 STRUCTURAL LABEL PRIOR — a composition-root pass (cli/ may import codebase/, diff/ may NOT). Before the
// LLM cluster/label pass runs, compute how each changed symbol sits in the WIDER codebase (its fan-in — is it
// a load-bearing hub or a leaf) and hand it to the labeler as a PRIOR, so the product-intent label is grounded
// in what the symbol IS in the system, not guessed from diff text alone ("tighten the auth gate (consumed by
// 40 sites)" vs a flat "validation tweak"). The result is a plain `Map<hunkId, note>` — diff/ stays ignorant
// of codebase/; it just receives a data bag, exactly like injected facts. Cheap + budgeted (one direct-
// consumer count per changed subject, shared EngineCtx); degrades to {} on any failure → labels fall back to
// diff-text-only. Runs only under --review-impact (where the footprint cost is already part of the workflow).
import { RegexFactsProvider } from "../diff/facts.js";
import type { Hunk } from "../diff/parser.js";
import { scan_consumers_batch } from "../core/resolve/consumers.js";
import { normpath } from "../core/resolve/walk.js";

const HUB = 8;   // ≥ this many direct consumers ⇒ a load-bearing hub (mirrors review_impact.HUB_FANIN)

// hunkId → a short structural note for the changed symbol with the largest fan-in in that hunk. Only set when
// the symbol has ≥1 in-repo consumer (a leaf with none carries no useful prior). noise hunks are pre-marked by
// noise_filter (roles aren't assigned yet at this point), so we skip them by that flag alone. Fan-in comes from
// scan_consumers_batch — ONE index pass for ALL changed subjects (was projectImpact per symbol, the slow path).
export async function computeStructuralContext(repo: string, hunks: Hunk[], opts: { maxSymbols?: number } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return out;
  const facts = await new RegexFactsProvider().facts(work);
  const RUNAWAY = opts.maxSymbols ?? 4000;
  const subjectsByHunk = new Map<string, string[]>();
  const allSubjects: { file: string; symbol: string }[] = [];
  const seen = new Set<string>();
  for (const h of work) {
    const f = facts.get(h.id);
    const subjects = f ? [...new Set([...f.defines, ...f.enclosing])].filter(Boolean) : [];
    subjectsByHunk.set(h.id, subjects);
    for (const sym of subjects) { const k = `${normpath(h.file_path)}::${sym}`; if (!seen.has(k) && seen.size < RUNAWAY) { seen.add(k); allSubjects.push({ file: h.file_path, symbol: sym }); } }
  }
  let batch: Map<string, { status: string }[]>;
  try { batch = await scan_consumers_batch(repo, allSubjects) as Map<string, { status: string }[]>; } catch { return out; }
  const fanOf = (file: string, sym: string) => (batch.get(`${normpath(file)}::${sym}`) ?? []).filter((c) => c.status === "RESOLVED_FULL").length;
  for (const h of work) {
    let best = 0, bestSym = "";
    for (const sym of subjectsByHunk.get(h.id) ?? []) { const fan = fanOf(h.file_path, sym); if (fan > best) { best = fan; bestSym = sym; } }
    if (best >= 1) out.set(h.id, `${bestSym} consumed by ${best} site(s)${best >= HUB ? " — HUB (load-bearing)" : ""}`);
  }
  return out;
}
