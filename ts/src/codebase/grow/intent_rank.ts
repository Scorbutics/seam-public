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

// Rank-banded tiering and intent-spine member marking now live in the CORE
// (rust/crates/seam-grow/src/intent_rank.rs) — see rust/parity/intent_rank.ts for the differential.
//
// Both cross as NAKED VECTORS (doubles in, tiers/flags out) rather than as seam DTOs. Measured: a f64 that
// goes out through `JSON.stringify` and back through `serde_json` returns 1 ULP low, and `relevance` is
// compared with `>=` on the far side. Not sending the values back is the only way that cannot bite.
function _core_or_die(): any {
  const a = _loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  return a;
}

export function bandTiers<T extends { relevance?: number }>(seams: T[]): void {
  if (!seams.length) return;
  const tiers: (string | null)[] = JSON.parse(_core_or_die().growBandTiers(
    seams.map((s) => (typeof s.relevance === "number" ? s.relevance : undefined)),
    seams.map((s) => (s as any).tier ?? undefined)));
  // an unscored seam comes back null and keeps whatever tier it had — it is not a LOW-scoring seam
  seams.forEach((s, i) => { if (tiers[i] != null) (s as any).tier = tiers[i]; });
}

// HOPS DECIDE, relevance only breaks ties inside a hop band — see `mark_spine_members` (Rust) for the
// measurement behind that. `hops` rides alongside `relevance` and is absent under a structural grow, which is
// what selects the legacy relevance-above-mean rule on the other side.
export function markSpineMembers(hunks: any[]): void {
  if (!hunks.length) return;
  const flags: (boolean | null)[] = JSON.parse(_core_or_die().growMarkSpineMembers(
    hunks.map((h) => (typeof h.relevance === "number" ? h.relevance : undefined)),
    hunks.map((h) => (typeof h.hops === "number" ? h.hops : undefined))));
  hunks.forEach((h, i) => { if (flags[i] != null) h.spine = flags[i]; });
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
