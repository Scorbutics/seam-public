// EMBEDDING ANCHOR RECALL (opt-in, #2 Slice B). A semantic recall layer over the DEF TABLE — it surfaces
// the anchor whose NAME doesn't lexically match the intent (the name-filter's blind spot). ADDITIVE: its
// output unions with the lexical candidates and flows into the existing probe→judge; it never touches the
// floor. Deterministic def enumeration + a SUGGEST similarity ranking; the LLM judge still SELECTS. The
// embedding machinery itself lives in scan/def_embed (shared with the grow intent-ranker, no layer back-edge).
import { type Def } from "../scan/def_table.js";
import { embedScoreDefs } from "../scan/def_embed.js";

// Top-K defs by similarity to the intent — anchor recall (additive over the lexical floor; the LLM judge
// still SELECTS). A thin wrapper over the shared scan-layer scorer. Returns [] when embeddings are absent.
export async function embed_anchor_candidates(repo: string, intent: string,
    opts: { k?: number } = {}): Promise<Def[]> {
  return (await embedScoreDefs(repo, intent)).slice(0, opts.k ?? 20).map((x) => x.def);
}
