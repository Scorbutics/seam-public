// Port of src/diff/engine.py — the per-pass classifier orchestrator. Full matrix ported:
//   cluster ∈ {det, llm, hybrid} · roles ∈ {det, llm, hybrid} · wiring ∈ {det, llm, hybrid}
// plus the optimized all-LLM path. Passes run in dependency order: roles → wiring → cluster.
import * as det from "./classifier_det.js";
import * as llm from "./classifier_llm.js";
import { RegexFactsProvider, type FactsProvider, type HunkFacts } from "./facts.js";
import type { Hunk } from "./parser.js";
import { intersect, sorted, union } from "../core/sets.js";

export const DEFAULTS = { cluster: "llm", roles: "det", wiring: "hybrid" } as const;
const ENGINES = ["llm", "det", "hybrid"];

export async function classify(hunks: Hunk[], opts: {
  cluster?: string; roles?: string; wiring?: string; facts_provider?: FactsProvider;
  repo?: string; model?: string; claudeBin?: string | null; roleVotes?: number;
} = {}): Promise<void> {
  const cluster = opts.cluster ?? "llm", roles = opts.roles ?? "det", wiring = opts.wiring ?? "hybrid";
  for (const [k, v] of Object.entries({ cluster, roles, wiring }))
    if (!ENGINES.includes(v)) throw new Error(`engine: ${k} must be one of ${ENGINES.join("|")} (got ${v})`);
  const llmOpts = { model: opts.model, claudeBin: opts.claudeBin };
  // The classifier operates on NON-noise hunks (Python's run.py filters before engine.classify;
  // here engine.classify is given the full array and filters itself, so the all-LLM path agrees).
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return;

  // All-LLM → the optimized path (cluster + role-voting + wire), then the shared post-passes.
  if (cluster === "llm" && roles === "llm" && wiring === "llm") {
    llm.classify_all_llm(work, { ...llmOpts, roleVotes: opts.roleVotes });
    det.merge_clusters_by_intent(work);
    det.assign_spans(work, opts.repo);
    return;
  }
  const needFacts = [cluster, roles, wiring].some((p) => p === "det" || p === "hybrid");
  const facts = needFacts ? await (opts.facts_provider ?? new RegexFactsProvider()).facts(work) : new Map<string, HunkFacts>();

  // ROLES
  if (roles === "llm") llm.assign_roles(work, { ...llmOpts, roleVotes: opts.roleVotes });
  else {
    det.assign_roles(work, facts);
    if (roles === "hybrid") llm.reconcile_roles_llm(work, llmOpts);   // LLM re-judges the uncertain
  }

  // WIRING (reads roles). Seam MERGING is deferred until after clustering (a thunk).
  let seamMerge: (() => void) | null = null;
  if (wiring === "llm") {
    llm.assign_wiring(work, llmOpts);                                  // Pass C (authoritative)
  } else {
    det.assign_wiring(work, facts);                                    // symbol candidates
    if (wiring === "det") {
      det.reconcile_wiring(work, facts);
      seamMerge = () => det.merge_seams(work);
    } else {
      // SEED-cleaning drop set (per link → cores to omit from the LLM hint), via the edge-resolution
      // ladder: when a repo is available, resolve cross-file candidate edges (principled, per-edge);
      // else fall back to the repo-free `coimport_externals` density heuristic. Cleans the seed only —
      // the LLM re-adds real couplings from meaning, so recall is preserved (hard-pruning isn't).
      const coreIds = new Set(work.filter((h) => h.role === "core").map((h) => h.id));
      const drop = opts.repo
        ? await det.resolve_coincidence(work, facts, coreIds, opts.repo)
        : det.coimport_drop(work, facts, coreIds);
      seamMerge = hybridWiring(work, facts, llmOpts, drop);          // LLM draw + det grounding
    }
  }

  // CLUSTERS (reads the full wiring graph for det; independent for the LLM)
  if (cluster === "llm") llm.assign_clusters(work, llmOpts);
  else {
    det.assign_clusters(work, facts);
    if (cluster === "hybrid") llm.label_clusters_llm(work, llmOpts);   // LLM prose labels over det groups
  }

  if (seamMerge) seamMerge();
  det.merge_clusters_by_intent(work);
  det.assign_spans(work, opts.repo);
}

// The hybrid wiring (LLM-first): the LLM groups cores into seams + draws each edit's line by
// meaning; determinism GROUNDS the draw and prunes the over-wired ungrounded ones.
function hybridWiring(work: Hunk[], facts: Map<string, HunkFacts>,
                      llmOpts: { model?: string; claudeBin?: string | null },
                      drop: Map<string, Set<string>>): (() => void) | null {
  const cores = new Map<string, Hunk>();
  for (const h of work) if (h.role === "core") cores.set(h.id, h);
  const targets = work.filter((h) => h.role !== "core");
  if (!cores.size) return null;
  const coreIds = new Set(cores.keys());
  const anchors = det._anchors(work, facts, coreIds);
  // Clean the LLM wiring SEED of cross-file co-import noise: drop a candidate core from an edit's hint
  // when import-resolution shows the shared symbol is NOT that core's (resolves elsewhere) — see
  // det.resolve_coincidence. This biases the seed, not the answer — the LLM still re-adds real
  // couplings from meaning, and det clustering/grounding (which read h.wires) are untouched. The
  // resolution signal is principled & per-edge (no _COIMPORT_DOMINANCE threshold); inert without repo.
  const hints = new Map<string, string[]>();
  for (const h of targets) {
    const d = drop.get(h.id);
    hints.set(h.id, d ? [...h.wires].filter((c) => !d.has(c)) : [...h.wires]);
  }
  const { labels, groups, drawn } = llm.reconcile_llm(cores, targets, hints, llmOpts);
  for (const h of targets) {
    const line = drawn.get(h.id);
    if (line === undefined) continue;
    const m = det._mentions(facts.get(h.id)!);
    const owned = new Set<string>();
    for (const c of cores.keys())
      if (intersect(intersect(anchors.get(c) ?? new Set(), m), facts.get(c)!.defines).size) owned.add(c);
    const resolved = new Set(h.resolved_wires.filter((c) => coreIds.has(c)));
    const grounded = intersect(union(owned, resolved), coreIds);
    const drawnSet = intersect(union(union(new Set(line), owned), resolved), coreIds);
    const [kept, suggested] = det.grounded_prune(drawnSet, grounded);
    h.wires = sorted(kept);
    h.suggested_wires = sorted(suggested);
  }
  return () => det.apply_seam_groups(work, labels, groups, true, facts);
}
