// LLM query-expansion for the fuzzy entry ramp. Turns a free-text INTENT into identifier-style
// keywords likely to appear in the NAMES of the symbols that implement it, so the deterministic
// candidate scan (anchor_rank.find_anchor_candidates) can reach symbols the literal words miss
// (e.g. "prevent double booking" → reservation, slot, conflict). The LLM only proposes vocabulary;
// every term is grounded by the deterministic repo scan, so a hallucinated keyword simply finds
// nothing. Kept OUT of anchor_rank.ts so that module stays offline/pure (it has its own tests).
import { run_pass, run_pass_async, ClassifierError } from "../core/llm.js";

function _prompt(intent: string): string {
  return `You convert a short INTENT describing a feature or behaviour in a codebase into a set of
identifier-style KEYWORDS that are likely to appear in the NAMES of the classes, functions, or
files that implement it.

Rules:
- Output single-word, lowercase, code-style keywords (no spaces, no phrases).
- Include close synonyms and the domain nouns/verbs the literal wording may omit.
- Prefer words a developer would actually use when naming code, not generic filler.
- Between 4 and 8 keywords.

INTENT: ${intent}

Return ONLY a JSON array with a single object, no prose:
[{"id": "expand", "terms": ["keyword1", "keyword2"]}]`;
}

// Up to 12 lowercased keyword stems-of-intent (deduped) from the LLM's reply.
function _parse(out: Map<string, any>): string[] {
  const raw: unknown = out.get("expand")?.terms;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const w = t.trim().toLowerCase();
    if (w.length > 2 && !seen.has(w)) { seen.add(w); terms.push(w); }
  }
  return terms.slice(0, 12);
}

// Returns up to 12 keyword stems-of-intent. Empty on any LLM failure so the caller falls back to the
// deterministic result rather than erroring (mirrors llm_discovery).
export function expand_intent_terms(
  intent: string,
  opts: { model?: string; claudeBin?: string | null } = {},
): string[] {
  try { return _parse(run_pass(_prompt(intent), { model: opts.model, claudeBin: opts.claudeBin, tag: "expand" })); }
  catch (e) { if (e instanceof ClassifierError) return []; throw e; }
}

// Async twin — so the `expand` pass can run CONCURRENTLY with the independent `entrypoint-select` pass
// (both precede the anchor decision and don't depend on each other) on the direct claude path.
export async function expand_intent_terms_async(
  intent: string,
  opts: { model?: string; claudeBin?: string | null } = {},
): Promise<string[]> {
  try { return _parse(await run_pass_async(_prompt(intent), { model: opts.model, claudeBin: opts.claudeBin, tag: "expand" })); }
  catch (e) { if (e instanceof ClassifierError) return []; throw e; }
}
