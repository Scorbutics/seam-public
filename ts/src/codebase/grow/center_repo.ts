// CENTER-FIRST detection (repo-wide, NO grow, NO anchor). Picking a concern's mechanism from an intent PHRASE
// is a SEMANTIC mapping (phrase ↔ codebase) — so when no --center is provided we ask the LLM DIRECTLY. Two
// deliberate simplifications (Brice): (1) an agent passes --center and this never runs — the LLM is the ONLY
// thing in the loop and only for pure-CLI use; (2) NO embedding pre-rank — once the LLM is picking, an embedding
// score adds nothing in practice (and it was unreliable on weak-embedding repos). STRUCTURE only casts a wide
// RECALL net — defs whose identity lexically TOUCHES an intent term (recall, never the decision; CLAUDE.md) —
// and the LLM makes the pick. Offline (no judge) degrades to the lexical floor.
import { enumerate_defs } from "../scan/index.js";
import type { Def } from "../scan/index.js";
import type { Center } from "./center.js";

export type CenterCandidate = { symbol: string; file: string; kind: string; signature: string };
// INJECTED semantic judge (auto→llm) — returns the picked `symbol file` ids. Kept out of this module so it needs
// no LLM import; absent/failed → the lexical floor. This is the one semantic step, skipped when --center is given.
export type CenterJudge = (intent: string, candidates: CenterCandidate[]) => Promise<string[] | null>;

const _STOP = new Set(["how", "are", "is", "the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "on", "by", "do", "does", "we", "this", "that", "what", "where", "which", "from", "managed", "used", "handled", "work", "works"]);
function _terms(intent: string): string[] {
  return [...new Set(intent.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !_STOP.has(w)))];
}
// NOISE files — never the mechanism (tests/fixtures, and DTO/input/output/type-decl shapes whose names match
// the intent as strongly as the real service). Excluded from the recall net so they can't crowd out the mechanism.
const _TEST = /(?:^|\/)(?:tests?|__tests__|e2e|cypress|spec|mocks?|fixtures?)(?:\/|$)|\.(?:test|spec|cy|e2e-spec|stories|test-samples|d|input|output|dto)\.[jt]sx?$/i;
const _camel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
// LEXICAL relevance (NOT embeddings) — how strongly a def's IDENTITY matches the intent. A term hit in the NAME
// (createBooking ~ "create"+"booking") is worth far more than one in the file path, so the actual mechanism
// ranks above a controller/handler that merely lives under a matching directory. This is the RANK that fits the
// mechanism inside the cap the LLM sees; the LLM still makes the pick — this only orders the candidate net.
function _score(d: Def, terms: string[]): number {
  const nameW = _camel(d.name), enclPath = `${d.enclosing} ${d.file}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (nameW.some((w) => t.includes(w) || w.includes(t))) s += 3;    // strong — in the symbol name
    else if (enclPath.includes(t)) s += 1;                            // weak — in the enclosing class / path
  }
  return s;
}

export async function detectCentersRepoWide(
  repo: string, intent: string, opts: { k?: number; cap?: number; judge?: CenterJudge; debug?: (l: string) => void } = {},
): Promise<Center[]> {
  const k = Math.max(1, opts.k ?? 4);
  const terms = _terms(intent);
  if (!terms.length) return [];
  const defs = await enumerate_defs(repo);
  // RECALL net — defs whose identity lexically matches the intent, RANKED (name-hits ≫ path-hits) so the
  // mechanism sits at the top, tests excluded, then capped. Wide by design (recall, not precision); the LLM picks.
  const recall = defs.filter((d) => d.kind !== "module" && !_TEST.test(d.file))
    .map((d) => ({ d, s: _score(d, terms) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s).slice(0, opts.cap ?? 80).map((x) => x.d);
  if (!recall.length) return [];
  opts.debug?.(`[center-first] ${recall.length} recall candidate(s) for intent terms [${terms.join(", ")}]`);
  const cands: CenterCandidate[] = recall.map((d) => ({ symbol: d.name, file: d.file, kind: d.kind, signature: d.signature }));
  let picked = cands;
  if (opts.judge) {
    try {
      const ids = await opts.judge(intent, cands);
      if (ids && ids.length) { const set = new Set(ids); const p = cands.filter((c) => set.has(`${c.symbol} ${c.file}`)); if (p.length) picked = p; }
    } catch { /* offline / judge failed → lexical floor */ }
  }
  return picked.slice(0, k).map((c) => ({ id: `${c.file}#${c.symbol}`, file: c.file, symbol: c.symbol, fanIn: 0 }));
}
