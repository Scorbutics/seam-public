// DETERMINISTIC intent-relevance for a grown footprint. The grow returns the full structural closure of
// an anchor (often broad — a REST entry transitively imports schema/projection/etc.). Separating the
// intent SPINE from off-intent infrastructure is a semantic call — but a DETERMINISTIC one via embeddings
// (CLAUDE.md: "the LLM OR embeddings"): we score each seam's primary def by cosine similarity of its
// embed-string to the intent, reusing the cached def-embedding index (no LLM call, reproducible, offline).
// Validated to recover the intent path (XPLAN flow ranks top, JSON-schema/DocuSign noise sinks) on a real
// repo. ADDITIVE: it only ANNOTATES seams with a `relevance` score (and a rank-banded `tier`) — it never
// drops or reorders them. The consumer (the agent, or the concern/agent render) ranks; the engine doesn't.
// Degrades to a no-op when embeddings are unavailable (the .vsix externalizes transformers) or no intent.
import { loadAddon as _loadAddon } from "../rust_core.js";
// The registry's set, not a copy. This was a THIRD hardcoded list of store kinds and the most drifted of
// them: it never had `service` or `egress` (so a stateful SDK handle and an outbound call never counted as
// store seams here, while every other reader treated them as such), on top of the stale `file`/`key`/
// `db-table` names the registry itself had.
import { STORE_KINDS as _STORE_KINDS } from "../render/medium_registry.js";
// The def/embedding reads come from the CORE (rust/seam_core.node). Byte-identical to the TypeScript scan
// they replaced — rust/parity/{deftable,defembed}.ts — and this is the last thing that kept `scan/` alive.
const _core = (): any => _loadAddon();

// Data-store boundary kinds — a sink of these is a table/queue the flow persists into. Their LABEL (the table
// name) is the semantic signal, but a `member_access` table (`bookingRepository`) has no matching DEF, so a
// def-only embed leaves it unscored (rel=-1) and it loses the spine crown to any scored off-subject write.
const _isStoreSeam = (s: any): boolean => (s.hunks ?? []).some((h: any) => _STORE_KINDS.has(h.kind ?? ""));
const _storeLabel = (s: any): string | undefined => s.primary?.symbol ?? s.label;

// Deterministic intent-relevance is an OPTIONAL enrichment (embeddings). It must NEVER block the core seam
// emit: embedScoreDefs can fail/abort on a large repo (WASM heap), and a degraded-but-present result beats none.
// Mutates `model` in place; on failure leaves seams un-annotated.
export async function annotateForEmit(repo: string, intent: string | undefined, model: any): Promise<void> {
  // When the LLM border shaped the grow (model.llmBorder), the kept footprint is ALREADY intent-scoped by the
  // LLM — so the embedding RE-rank is redundant and can mis-score what the LLM correctly kept (the documented
  // 0.11-on-a-real-mechanism-node case). Skip it and degrade exactly as when embeddings are absent (the LLM is
  // the ranker). Embeddings stay the deterministic FALLBACK ranker only when there's no LLM border (no backend).
  if (model.llmBorder) return;
  try {
    await annotateIntentRelevance(repo, intent, model.clusters);
  } catch (e) {
    process.stderr.write(`intent-relevance annotation skipped: ${(e as Error).message}\n`);
  }
}

// Rank-banded tier from a seam's position in the relevance ordering — threshold-free (no magic cosine
// cutoff that drifts per repo/model): the top band is the spine, the middle is supporting, the tail is off.
// Deterministic given the scores. A coarse 3-band split — the consumer refines if it wants.
// Fraction of the run's TOP relevance below which a seam is OFF-intent regardless of its rank. RELATIVE (to
// this run's best seam), NOT an absolute cosine — so it's reproducible and does NOT drift per repo/model. It
// only ever DEMOTES (crops the long mildly-relevant tail out of supporting); the top seam is always kept.
const _OFF_INTENT_FLOOR = 0.5;
export function bandTiers<T extends { relevance?: number }>(seams: T[]): void {
  // A STRUCTURAL spine (the crossing backbone, locked in emit_seams — tier-independent) takes precedence:
  // never re-band a spine seam, and don't mint MORE spine from text similarity. The embeddings then only
  // split the REMAINDER into supporting/off (a 2-band). Only when there's NO structural spine (a policy fan
  // / a same-language flow with no boundary) does the embedding band define the spine itself (the 3-band).
  const lockedSpine = seams.some((s) => (s as any).tier === "spine");
  const scored = seams.filter((s) => typeof s.relevance === "number" && (s as any).tier !== "spine").sort((a, b) => (b.relevance! - a.relevance!));
  const n = scored.length;
  if (!n) return;
  // RELATIVE off-intent floor: a seam far below the most-relevant one is off-intent however it ranks — so a
  // long tail of mildly-related infrastructure lands in OFF (croppable) instead of bloating supporting.
  const floor = scored[0].relevance! * _OFF_INTENT_FLOOR;
  const isOff = (s: T) => (s.relevance ?? 0) < floor;
  const band = lockedSpine
    ? (i: number) => (i < Math.ceil(n / 2) ? "supporting" : "off")
    : (i: number) => (i < Math.ceil(n / 3) ? "spine" : i < Math.ceil((2 * n) / 3) ? "supporting" : "off");
  scored.forEach((s, i) => { (s as any).tier = isOff(s) ? "off" : band(i); });
}


// Within a SEAM, flag the most intent-relevant MEMBERS as the spine. The structural floor collapses a
// tangled (god-object / DI-heavy) closure into one big seam, so seam-level tiering has nothing to separate
// — but the embedding still tells us WHICH members of that blob answer the intent. Mark the top relevance
// band (≥ the seam's mean of scored members; capped) as `spine`, so a consumer can surface the intent path
// inside the tangle. Deterministic, no LLM. No-op on a seam with <2 scored members (nothing to rank).
const _SPINE_MEMBER_CAP = 12;   // "the path" inside a blob is a handful, not the top third — cap hard
export function markSpineMembers(hunks: any[]): void {
  const scored = hunks.filter((h) => typeof h.relevance === "number");
  if (scored.length < 2) { if (scored.length === 1) scored[0].spine = true; return; }
  const mean = scored.reduce((a, h) => a + h.relevance, 0) / scored.length;
  const cap = Math.min(_SPINE_MEMBER_CAP, Math.max(1, Math.ceil(scored.length / 4)));
  const top = [...scored].sort((a, b) => b.relevance - a.relevance);
  let n = 0;
  for (const h of top) h.spine = h.relevance >= mean && n++ < cap;   // top, above-average members only
}

// Annotate every seam (and its MEMBERS) with a deterministic `relevance` (0..1 cosine, embed vs intent) and a
// rank-banded `tier`. Keyed by each def (file::symbol), with a name-only fallback. Mutates in place. No-op
// without an intent or when embeddings are unavailable.
export async function annotateIntentRelevance(repo: string, intent: string | undefined, clusters: any[]): Promise<boolean> {
  if (!intent || !clusters?.length) return false;
  // FOOTPRINT-SCOPED: embed just the files this footprint lives in (seam primaries AND every member hunk —
  // so intra-seam members can be ranked, not just the seam reps), not a whole-repo tree-sitter + embed pass.
  // On a huge repo that turns a 4000-def walk into a footprint-sized one; canonical rels keep cache parity.
  const files = new Set<string>();
  for (const cl of clusters) for (const s of (cl.seams ?? [])) {
    if (s.primary?.file) files.add(s.primary.file);
    for (const h of (s.hunks ?? [])) if (h.file) files.add(h.file);
  }
  const scored = _core().embedScoreDefs(repo, intent, files.size ? [...files] : null) as { def: any; score: number }[];
  if (!scored.length) return false;   // transformers absent / no defs → leave seams unannotated (graceful)

  const byKey = new Map<string, number>();   // file::name → best score
  const byName = new Map<string, number>();  // name → best score (fallback when the file differs)
  for (const { def, score } of scored) {
    const k = `${def.file}::${def.name}`;
    if (!byKey.has(k)) byKey.set(k, score);
    if (!byName.has(def.name)) byName.set(def.name, score);
  }
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  const scoreOf = (file?: string, sym?: string): number | undefined =>
    sym ? (byKey.get(`${file}::${sym}`) ?? byName.get(sym)) : undefined;

  for (const cl of clusters) for (const s of (cl.seams ?? [])) {
    const ss = scoreOf(s.primary?.file, s.primary?.symbol);
    if (ss !== undefined) s.relevance = round3(ss);
    // per-MEMBER relevance (skip synthetic caller/summary hunks — they have no own def to score)
    for (const h of (s.hunks ?? [])) {
      if (h.caller || h.summary) continue;
      const hs = scoreOf(h.file, h.label);
      if (hs !== undefined) h.relevance = round3(hs);
    }
  }
  // LABEL FALLBACK — a boundary/table sink a def-embed couldn't score (a member_access table has no def) is scored
  // by its LABEL string vs the intent, on the SAME cosine scale. This is what lets a "how is a booking cancelled"
  // intent crown `bookingRepository` over an equally-direct `WorkflowRepository` write: the table NAME carries the
  // subject. Deterministic (embeddings, cached), additive, and degrades to a no-op if embeddings abort.
  const need = new Set<string>();
  for (const cl of clusters) for (const s of (cl.seams ?? [])) {
    if (typeof s.relevance === "number" || !_isStoreSeam(s)) continue;
    const lbl = _storeLabel(s); if (lbl) need.add(lbl);
  }
  if (need.size) {
    try {
      const ls = new Map<string, number>(Object.entries(_core().embedScoreStrings(intent, [...need]) as Record<string, number>));
      for (const cl of clusters) for (const s of (cl.seams ?? [])) {
        if (typeof s.relevance === "number" || !_isStoreSeam(s)) continue;
        const sc = ls.get(_storeLabel(s) ?? "");
        if (sc !== undefined) s.relevance = round3(sc);
      }
    } catch { /* embeddings aborted — leave the store sinks unscored, as before */ }
  }
  for (const cl of clusters) { for (const s of (cl.seams ?? [])) markSpineMembers(s.hunks ?? []); bandTiers(cl.seams ?? []); }
  return true;
}
