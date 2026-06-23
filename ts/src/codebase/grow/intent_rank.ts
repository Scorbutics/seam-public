// DETERMINISTIC intent-relevance for a grown footprint. The grow returns the full structural closure of
// an anchor (often broad — a REST entry transitively imports schema/projection/etc.). Separating the
// intent SPINE from off-intent infrastructure is a semantic call — but a DETERMINISTIC one via embeddings
// (CLAUDE.md: "the LLM OR embeddings"): we score each seam's primary def by cosine similarity of its
// embed-string to the intent, reusing the cached def-embedding index (no LLM call, reproducible, offline).
// Validated to recover the intent path (XPLAN flow ranks top, JSON-schema/DocuSign noise sinks) on a real
// repo. ADDITIVE: it only ANNOTATES seams with a `relevance` score (and a rank-banded `tier`) — it never
// drops or reorders them. A consumer (the agent, or a future --spine-only) ranks/crops; the engine doesn't.
// Degrades to a no-op when embeddings are unavailable (the .vsix externalizes transformers) or no intent.
import { embedScoreDefs } from "../scan/def_embed.js";

// Rank-banded tier from a seam's position in the relevance ordering — threshold-free (no magic cosine
// cutoff that drifts per repo/model): the top band is the spine, the middle is supporting, the tail is off.
// Deterministic given the scores. A coarse 3-band split — the consumer refines if it wants.
export function bandTiers<T extends { relevance?: number }>(seams: T[]): void {
  const scored = seams.filter((s) => typeof s.relevance === "number").sort((a, b) => (b.relevance! - a.relevance!));
  const n = scored.length;
  if (!n) return;
  scored.forEach((s, i) => {
    (s as any).tier = i < Math.ceil(n / 3) ? "spine" : i < Math.ceil((2 * n) / 3) ? "supporting" : "off";
  });
}

// --spine-only crop: deterministically drop the OFF-intent band (tier === "off"), keeping spine +
// supporting in full. HONEST + lossless-by-reference — each dropped seam leaves a compact stub
// (label + relevance + file) in `cluster.omitted`, so the consumer SEES what was cut and can re-query full;
// nothing is silently hidden. No-op when tiers are absent (embeddings unavailable) — so it degrades to the
// full closure rather than cropping blind (the engine never judges-by-hiding without a basis). Returns the
// omitted count. Reproducible (the tier is the embedding ranking, not an LLM).
export function cropOffIntent(clusters: any[]): number {
  let omitted = 0;
  for (const cl of clusters ?? []) {
    const keep: any[] = [], drop: any[] = [];
    for (const s of (cl.seams ?? [])) (s.tier === "off" ? drop : keep).push(s);
    if (!drop.length) continue;
    cl.seams = keep;
    cl.omitted = drop.map((s) => ({ id: s.id, label: s.label, relevance: s.relevance, file: s.primary?.file }))
      .sort((a: any, b: any) => (b.relevance ?? 0) - (a.relevance ?? 0));
    omitted += drop.length;
  }
  return omitted;
}

// Annotate every seam in the clusters with a deterministic `relevance` (0..1 cosine, embed vs intent) and a
// rank-banded `tier`. Keyed by the seam's primary def (file::symbol), with a name-only fallback. Mutates in
// place. No-op without an intent or when embeddings are unavailable.
export async function annotateIntentRelevance(repo: string, intent: string | undefined, clusters: any[]): Promise<boolean> {
  if (!intent || !clusters?.length) return false;
  // FOOTPRINT-SCOPED: we only score THIS footprint's seams, so embed just the files they live in — not a
  // whole-repo tree-sitter + embed pass. On a huge repo that turns a 4000-def walk into a few-dozen-file
  // one (the seams' own files), and the canonical rels keep cache parity with the anchor-recall pass.
  const files = new Set<string>();
  for (const cl of clusters) for (const s of (cl.seams ?? [])) if (s.primary?.file) files.add(s.primary.file);
  const scored = await embedScoreDefs(repo, intent, files.size ? files : undefined);
  if (!scored.length) return false;   // transformers absent / no defs → leave seams unannotated (graceful)

  const byKey = new Map<string, number>();   // file::name → best score
  const byName = new Map<string, number>();  // name → best score (fallback when the file differs)
  for (const { def, score } of scored) {
    const k = `${def.file}::${def.name}`;
    if (!byKey.has(k)) byKey.set(k, score);
    if (!byName.has(def.name)) byName.set(def.name, score);
  }

  for (const cl of clusters) {
    const seams = cl.seams ?? [];
    for (const s of seams) {
      const p = s.primary;
      if (!p?.symbol) continue;
      const score = byKey.get(`${p.file}::${p.symbol}`) ?? byName.get(p.symbol);
      if (score !== undefined) s.relevance = Math.round(score * 1000) / 1000;
    }
    bandTiers(seams);
  }
  return true;
}
