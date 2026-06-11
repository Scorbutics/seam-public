// Port of src/diff/engine.py — the per-pass classifier orchestrator. Only the DETERMINISTIC
// path is ported (cluster=roles=wiring="det"); llm/hybrid throw until the LLM passes land.
// This is what the CLI runs for `--classifier det`, and it differs from the standalone
// classifier_det.classify() by the trailing merge_clusters_by_intent cleanup.
import * as det from "./classifier_det.js";
import { RegexFactsProvider, type FactsProvider } from "./facts.js";
import type { Hunk } from "./parser.js";

export const DEFAULTS = { cluster: "llm", roles: "det", wiring: "hybrid" } as const;

export function classify(hunks: Hunk[], opts: {
  cluster?: string; roles?: string; wiring?: string; facts_provider?: FactsProvider; repo?: string;
} = {}): void {
  const cluster = opts.cluster ?? "llm", roles = opts.roles ?? "det", wiring = opts.wiring ?? "hybrid";
  if (cluster !== "det" || roles !== "det" || wiring !== "det") {
    throw new Error(`engine: only the deterministic path is ported (got cluster=${cluster} roles=${roles} `
      + `wiring=${wiring}). LLM/hybrid passes are not yet ported — see ts/PORT-STATUS.md.`);
  }
  const work = hunks.filter((h) => h.role !== "noise");
  if (!work.length) return;
  const facts = (opts.facts_provider ?? new RegexFactsProvider()).facts(work);

  det.assign_roles(work, facts);                 // ROLES
  det.assign_wiring(work, facts);                // WIRING (symbol candidates)
  det.reconcile_wiring(work, facts);             //   deterministic owned-prune
  det.assign_clusters(work, facts);              // CLUSTERS (full wiring graph, pre-merge)
  det.merge_seams(work);                         // same-component cores → multi-core seam
  det.merge_clusters_by_intent(work);            // collapse same-intent clusters (the engine cleanup)
  det.assign_spans(work, opts.repo);             // per-seam overlap placements + header peel
}
