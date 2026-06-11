// Port of src/diff/engine.py — the per-pass classifier orchestrator. Ported paths so far:
//   roles=det · cluster ∈ {det, llm} · wiring ∈ {det, hybrid}
// (the extension default is cluster=llm, roles=det, wiring=hybrid). The remaining all-LLM roles
// pass (Pass B voting) lands in Phase 4. Passes run in dependency order: roles → wiring → cluster.
import * as det from "./classifier_det.js";
import * as llm from "./classifier_llm.js";
import { RegexFactsProvider, type FactsProvider, type HunkFacts } from "./facts.js";
import type { Hunk } from "./parser.js";
import { intersect, sorted, union } from "../core/sets.js";

export const DEFAULTS = { cluster: "llm", roles: "det", wiring: "hybrid" } as const;

export function classify(hunks: Hunk[], opts: {
  cluster?: string; roles?: string; wiring?: string; facts_provider?: FactsProvider;
  repo?: string; model?: string; claudeBin?: string | null;
} = {}): void {
  const cluster = opts.cluster ?? "llm", roles = opts.roles ?? "det", wiring = opts.wiring ?? "hybrid";
  if (roles !== "det" || !["det", "llm"].includes(cluster) || !["det", "hybrid"].includes(wiring)) {
    throw new Error(`engine: ported paths are roles=det, cluster=det|llm, wiring=det|hybrid (got `
      + `cluster=${cluster} roles=${roles} wiring=${wiring}). Remaining LLM passes are in progress `
      + `— see ts/PORT-STATUS.md.`);
  }
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return;
  const facts = (opts.facts_provider ?? new RegexFactsProvider()).facts(work);
  const llmOpts = { model: opts.model, claudeBin: opts.claudeBin };

  det.assign_roles(work, facts);                 // ROLES (det)

  // WIRING (reads roles). Seam MERGING is deferred until AFTER clustering (a thunk).
  det.assign_wiring(work, facts);                // symbol candidates (the hint + grounding)
  let seamMerge: (() => void) | null = null;
  if (wiring === "det") {
    det.reconcile_wiring(work, facts);           // deterministic owned-prune
    seamMerge = () => det.merge_seams(work);
  } else {
    seamMerge = hybridWiring(work, facts, llmOpts);
  }

  // CLUSTERS (reads the full wiring graph for det; independent for the LLM)
  if (cluster === "llm") llm.assign_clusters(work, llmOpts);
  else det.assign_clusters(work, facts);

  if (seamMerge) seamMerge();                    // collapse same-intent cores into multi-core seams
  det.merge_clusters_by_intent(work);            // collapse same-intent clusters
  det.assign_spans(work, opts.repo);             // per-seam overlap placements + header peel
}

// The hybrid wiring (LLM-first): the LLM groups cores into seams + draws each edit's line by
// meaning; determinism GROUNDS the draw (re-adds owned-symbol edges it missed) and prunes the
// over-wired ungrounded ones. Returns the deferred apply_seam_groups thunk (or null when no cores).
function hybridWiring(work: Hunk[], facts: Map<string, HunkFacts>,
                      llmOpts: { model?: string; claudeBin?: string | null }): (() => void) | null {
  const cores = new Map<string, Hunk>();
  for (const h of work) if (h.role === "core") cores.set(h.id, h);
  const targets = work.filter((h) => h.role !== "core");
  if (!cores.size) return null;
  const coreIds = new Set(cores.keys());
  const hints = new Map<string, string[]>();
  for (const h of targets) hints.set(h.id, [...h.wires]);
  const { labels, groups, drawn } = llm.reconcile_llm(cores, targets, hints, llmOpts);
  const anchors = det._anchors(work, facts, coreIds);
  for (const h of targets) {
    const line = drawn.get(h.id);
    if (line === undefined) continue;            // LLM gave no list → keep det candidates
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
