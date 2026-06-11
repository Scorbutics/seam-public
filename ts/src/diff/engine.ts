// Port of src/diff/engine.py — the per-pass classifier orchestrator. Only the DETERMINISTIC
// path is ported (cluster=roles=wiring="det"); llm/hybrid throw until the LLM passes land.
// This is what the CLI runs for `--classifier det`, and it differs from the standalone
// classifier_det.classify() by the trailing merge_clusters_by_intent cleanup.
import * as det from "./classifier_det.js";
import * as llm from "./classifier_llm.js";
import { RegexFactsProvider, type FactsProvider } from "./facts.js";
import type { Hunk } from "./parser.js";

export const DEFAULTS = { cluster: "llm", roles: "det", wiring: "hybrid" } as const;

// Ported engine paths so far: roles=det, wiring=det, cluster ∈ {det, llm}. Other combinations
// (llm/hybrid roles & wiring) throw until their passes land (Phases 3-4).
export function classify(hunks: Hunk[], opts: {
  cluster?: string; roles?: string; wiring?: string; facts_provider?: FactsProvider;
  repo?: string; model?: string; claudeBin?: string | null;
} = {}): void {
  const cluster = opts.cluster ?? "llm", roles = opts.roles ?? "det", wiring = opts.wiring ?? "hybrid";
  if (roles !== "det" || wiring !== "det" || !["det", "llm"].includes(cluster)) {
    throw new Error(`engine: ported paths are roles=det, wiring=det, cluster=det|llm (got `
      + `cluster=${cluster} roles=${roles} wiring=${wiring}). Remaining LLM/hybrid passes are in `
      + `progress — see ts/PORT-STATUS.md.`);
  }
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return;
  const facts = (opts.facts_provider ?? new RegexFactsProvider()).facts(work);

  det.assign_roles(work, facts);                 // ROLES (det)
  det.assign_wiring(work, facts);                // WIRING (symbol candidates)
  det.reconcile_wiring(work, facts);             //   deterministic owned-prune
  if (cluster === "llm") llm.assign_clusters(work, { model: opts.model, claudeBin: opts.claudeBin });
  else det.assign_clusters(work, facts);         // CLUSTERS (full wiring graph, pre-merge)
  det.merge_seams(work);                         // same-component cores → multi-core seam
  det.merge_clusters_by_intent(work);            // collapse same-intent clusters (the engine cleanup)
  det.assign_spans(work, opts.repo);             // per-seam overlap placements + header peel
}
