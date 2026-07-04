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
// NOISE — never a mechanism: a segment that is a TEST/fixture/archived/generated/legacy tree (a whole segment
// OR a `test-…`/`archive…` prefixed one — Acme's `archived/bt/test-review-manage/` leaked in via
// "managed"~"manage"), or a DTO/type-decl file shape.
const _NOISE_FILE = /(?:^|\/)(?:tests?|test[-_][^/]*|__tests__|e2e|cypress|spec|mocks?|fixtures?|archived?|archive[-_][^/]*|generated?|gen|legacy|deprecated|vendor|examples?|samples?)(?:\/|$)|\.(?:test|spec|cy|e2e-spec|stories|test-samples|d|input|output|dto)\.[jt]sx?$/i;
// DATA/config classes are not mechanisms — a `*Constants`/`*Config`/`*Enum`/`*Dto` is behaviour-free, so picking
// it strands the concern on a dead-end (Acme: `BookingsConstants`, fan-in 0, 0 interactions).
const _DATA_NAME = /(?:Constants?|Config(?:uration)?|Enum|Dto|Vo|Props|Schema|Types?)$/;

const _camel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
// LEXICAL relevance (NOT embeddings): a term hit in the NAME (createBooking ~ "bookings") ≫ one in the path.
function _score(d: Def, terms: string[]): number {
  const nameW = _camel(d.name), enclPath = `${d.enclosing} ${d.file}`.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (nameW.some((w) => t.includes(w) || w.includes(t))) s += 3;   // strong — in the symbol name
    else if (enclPath.includes(t)) s += 1;                           // weak — enclosing class / path
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
  let callers = new Map<string, string[]>();
  try { callers = await symbolCallers(repo); } catch { /* no callsite index → fan-in 0, order by lexical */ }
  // RECALL net — defs whose identity lexically matches, tests/DTO/enum/constants excluded, DEDUPED, RANKED by
  // lexical score then FAN-IN (a dead-end constant loses to a called bean at equal name-match), then capped.
  const seen = new Set<string>();
  const recall = defs
    .filter((d) => d.kind !== "module" && d.kind !== "enum" && !_NOISE_FILE.test(d.file) && !_DATA_NAME.test(d.name))
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
