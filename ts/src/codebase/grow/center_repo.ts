// CENTER-FIRST detection (repo-wide, NO grow, NO anchor). Picking a concern's mechanism from an intent PHRASE
// is a SEMANTIC mapping (phrase ↔ codebase) — so when no --center is given we ask the LLM DIRECTLY. STRUCTURE
// casts a wide lexical RECALL net (recall, never the decision; CLAUDE.md) and the LLM makes the pick; an agent
// passes --center and this never runs (zero LLM); offline degrades to the lexical floor.
import { symbolCallers } from "../scan/class_graph.js";
import { enumerate_defs } from "../scan/index.js";
import type { Def } from "../scan/index.js";
import type { Center } from "./center.js";

export type CenterCandidate = { symbol: string; file: string; kind: string; signature: string; fanIn: number };
// INJECTED semantic judge (auto→llm) — returns the picked `symbol file` ids. Kept out of this module so it needs
// no LLM import; absent/failed → the lexical floor. Skipped when --center is given.
export type CenterJudge = (intent: string, candidates: CenterCandidate[]) => Promise<string[] | null>;

// Only TRUE function words — NOT domain verbs. "how are bookings managed" must keep "managed" (dropping it
// collapses the net to one noun, and a booking app then surfaces almost nothing — the Acme failure).
const _STOP = new Set(["how", "are", "is", "the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "on", "by", "do", "does", "we", "this", "that", "what", "where", "which", "from", "when", "been", "being", "its"]);
function _terms(intent: string): string[] {
  return [...new Set(intent.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !_STOP.has(w)))];
}
// The ONLY hardcoded exclusions are conventions, not project-specific guesses: standard TEST files (the same
// thing the grow drops unless --include-tests) and a `.d.ts` type-declaration (a language-spec fact — never a
// mechanism). NOT archived/generated/legacy/vendor/… — those are per-repo conventions (Brice: a project may
// keep real code in `generated/`); the dev excludes their own dead dirs via `--exclude`, and the LLM judge (which
// sees the path + fan-in) filters archived/data code semantically. A structural `enum` is dropped by kind below.
const _TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e|cypress)(?:\/|$)|\.(?:test|spec|cy|e2e-spec|stories|test-samples)\.[jt]sx?$/i;
const _TYPE_DECL = /\.d\.ts$/i;

const _camel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
// A term and a name-word match on EXACT equality or a PREFIX relation — `booking`~`bookings`, `manage`~`managed`
// (plural/tense differ only by a suffix). NOT arbitrary substring: that made `age` match `managed` (m-an-AGE-d),
// so every `*Age*` method matched the verb and buried the real mechanism (the Acme bug). Prefix needs
// ≥4 shared chars so a short word can't over-match.
const _wordHit = (w: string, t: string): boolean => w === t || (Math.min(w.length, t.length) >= 4 && (t.startsWith(w) || w.startsWith(t)));
// LEXICAL relevance (NOT embeddings): a term hit in the NAME (createBooking ~ "bookings") ≫ one in the path.
function _score(d: Def, terms: string[]): number {
  const nameW = _camel(d.name);
  // path segments (a def under .../bookings/ is booking code even if its own name isn't) — matched whole-segment
  // so `manage` can't hit `managed` and vice-versa via a loose substring.
  const seg = `${d.enclosing} ${d.file}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let s = 0;
  for (const t of terms) {
    if (nameW.some((w) => _wordHit(w, t))) s += 3;        // strong — in the symbol name
    else if (seg.some((w) => _wordHit(w, t))) s += 1;     // weak — enclosing class / path segment
  }
  return s;
}

export async function detectCentersRepoWide(
  repo: string, intent: string, opts: { k?: number; cap?: number; excludeDirs?: string[]; includeTests?: boolean; judge?: CenterJudge; debug?: (l: string) => void } = {},
): Promise<Center[]> {
  const k = Math.max(1, opts.k ?? 4);
  const terms = _terms(intent);
  if (!terms.length) return [];
  const defs = await enumerate_defs(repo);
  let callers = new Map<string, string[]>();
  try { callers = await symbolCallers(repo); } catch { /* no callsite index → fan-in 0, order by lexical */ }
  // the dev's OWN dead dirs (--exclude) — normalized to path prefixes/segments. Their call, not the engine's.
  const exDirs = (opts.excludeDirs ?? []).map((d) => d.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const inExcluded = (f: string) => exDirs.some((d) => { const p = f.replace(/^\.\//, ""); return p === d || p.startsWith(d + "/") || p.includes("/" + d + "/"); });
  // RECALL net — defs whose identity lexically matches, DEDUPED, RANKED by lexical score then FAN-IN (a dead-end
  // loses to a called bean at equal name-match), then capped. Exclusions are conventions/config only: type-decls,
  // tests (unless --include-tests), the dev's --exclude dirs, and structural `enum`/`module` kinds. The LLM judge
  // does the rest of the filtering (archived/data/off-intent) SEMANTICALLY — no hardcoded per-repo dir guesses.
  const seen = new Set<string>();
  const recall = defs
    .filter((d) => d.kind !== "module" && d.kind !== "enum" && !_TYPE_DECL.test(d.file) && (opts.includeTests || !_TEST_FILE.test(d.file)) && !inExcluded(d.file))
    .map((d) => ({ d, s: _score(d, terms), fan: callers.get(d.name)?.length ?? 0 }))
    .filter((x) => x.s > 0)
    .filter((x) => { const key = `${x.d.name} ${x.d.file}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => (b.s - a.s) || (b.fan - a.fan))
    .slice(0, opts.cap ?? 80);
  if (!recall.length) return [];
  opts.debug?.(`[center-first] ${recall.length} recall candidate(s) for [${terms.join(", ")}]: ${recall.slice(0, 14).map((x) => `${x.d.name}(${x.fan})`).join(", ")}`);
  const cands: CenterCandidate[] = recall.map((x) => ({ symbol: x.d.name, file: x.d.file, kind: x.d.kind, signature: x.d.signature, fanIn: x.fan }));
  let picked = cands;
  if (opts.judge) {
    try {
      const ids = await opts.judge(intent, cands);
      if (ids && ids.length) { const set = new Set(ids); const p = cands.filter((c) => set.has(`${c.symbol} ${c.file}`)); if (p.length) picked = p; }
    } catch { /* offline / judge failed → lexical floor */ }
  }
  return picked.slice(0, k).map((c) => ({ id: `${c.file}#${c.symbol}`, file: c.file, symbol: c.symbol, fanIn: c.fanIn }));
}
