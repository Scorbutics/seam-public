// Port of src/diff/engine.py — the per-pass classifier orchestrator. Full matrix ported:
//   cluster ∈ {det, llm, hybrid} · roles ∈ {det, llm, hybrid} · wiring ∈ {det, llm, hybrid}
// plus the optimized all-LLM path. Passes run in dependency order: roles → wiring → cluster.
//
// WHAT EACH SETTING DOES, per pass (not a strategy swap — "hybrid" runs det AND llm together, see below):
//   roles=llm     llm.assign_roles only.
//   roles=det     det.assign_roles only.
//   roles=hybrid  det.assign_roles, THEN llm.reconcile_roles_llm re-judges only the uncertain ones.
//   wiring=llm    llm.assign_wiring only ("Pass C", authoritative — no det grounding pass follows).
//   wiring=det    det.assign_wiring + det.reconcile_wiring; merge plan = {kind:"det"} (merge by file+component).
//   wiring=hybrid det.assign_wiring (candidates) + a coincidence-drop pass, THEN async hybridWiring():
//                 llm.reconcile_llm draws the wire, det grounds/prunes it; merge plan = {kind:"hybrid",...}.
//   cluster=llm   llm.assign_clusters (ASYNC) — runs concurrently with the wiring pass if that's also async.
//   cluster=det   det.assign_clusters only.
//   cluster=hybrid det.assign_clusters, THEN llm.label_clusters_llm adds LLM prose labels over the det groups.
//
// Three worked configs (roles, wiring, cluster in that dependency order):
//   {det, det, det}       — fully offline, no LLM calls anywhere. Fastest, least semantic.
//   DEFAULTS = {det, hybrid, llm} — the default: det roles, hybrid wiring (det draws candidates, LLM
//                 reconciles + grounds), llm clusters (runs concurrently with the wiring reconcile).
//   {llm, llm, llm}       — takes the SEPARATE all-LLM fast path at the top of classify() below
//                 (classify_all_llm does cluster+role-voting+wire in one shot), not the per-pass branches.
import * as det from "./classifier_det.js";
import * as llm from "./classifier_llm.js";
import { RegexFactsProvider, type FactsProvider, type HunkFacts } from "./facts.js";
import type { Hunk } from "./parser.js";
import { intersect, sorted, union } from "../core/sets.js";

export const DEFAULTS = { cluster: "llm", roles: "det", wiring: "hybrid" } as const;
const ENGINES = ["llm", "det", "hybrid"];

// How the deferred seam-MERGE step should run, as DATA rather than a closure — so the wiring phase
// outputs a plain plan and the merge phase consumes it, instead of the wiring phase handing the merge
// phase a thunk that secretly closes over the reconcile output across the cluster barrier.
//   det    → merge cores by file+enclosing component.
//   hybrid → merge by the LLM seam keys/labels (+ the det component floor), carrying that LLM output.
type MergePlan = { kind: "det" } | { kind: "hybrid"; labels: Map<string, string>; groups: Map<string, string> };

export async function classify(hunks: Hunk[], opts: {
  cluster?: string; roles?: string; wiring?: string; facts_provider?: FactsProvider;
  repo?: string; model?: string; claudeBin?: string | null; roleVotes?: number;
  fixedRoles?: Map<string, string>;   // pin roles (e.g. from gold) and SKIP the role pass — lets the
                                       // eval score wiring/clustering with role errors removed
  structuralContext?: Map<string, string>;   // #5: per-hunk codebase prior for the LLM cluster/label pass
                                              // (computed by the composition root; plain data, no codebase import)
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

  // ROLES — pinned (fixedRoles) bypass the role pass entirely; else det/llm/hybrid as configured.
  if (opts.fixedRoles) {
    for (const h of work) { h.role = opts.fixedRoles.get(h.id) ?? "environment"; h.role_confidence = 1.0; h.rationale = "role pinned (gold)"; }
  } else if (roles === "llm") llm.assign_roles(work, { ...llmOpts, roleVotes: opts.roleVotes });
  else {
    det.assign_roles(work, facts);
    if (roles === "hybrid") llm.reconcile_roles_llm(work, llmOpts);   // LLM re-judges the uncertain
  }

  // WIRING-SIGNAL PREP (shared): the per-core anchor symbols are the one derivation that the wiring
  // floor, the seed-clean, AND the reconcile grounding all consume — computed ONCE here (after roles
  // fix the core set) and threaded, instead of re-derived in each. Only the det/hybrid wiring uses it.
  const coreIds = new Set(work.filter((h) => h.role === "core").map((h) => h.id));
  const anchors = wiring === "llm" ? null : det._anchors(work, facts, coreIds);

  // WIRING (reads roles). Seam MERGING is deferred until after clustering, expressed as a DATA plan
  // (not a thunk). The hybrid wiring's reconcile LLM pass is kicked off as a PROMISE so it can overlap
  // the cluster LLM pass.
  let mergePlan: MergePlan | null = null;
  let wiringPromise: Promise<MergePlan | null> | null = null;
  if (wiring === "llm") {
    llm.assign_wiring(work, llmOpts);                                  // Pass C (authoritative)
  } else {
    det.assign_wiring(work, facts, anchors!);                          // symbol candidates
    if (wiring === "det") {
      det.reconcile_wiring(work, facts, undefined, anchors!);
      mergePlan = { kind: "det" };
    } else {
      // SEED-cleaning drop set (per link → cores to omit from the LLM hint), via the edge-resolution
      // ladder: when a repo is available, resolve cross-file candidate edges (principled, per-edge);
      // else fall back to the repo-free `coimport_externals` density heuristic. Cleans the seed only —
      // the LLM re-adds real couplings from meaning, so recall is preserved (hard-pruning isn't).
      const drop = opts.repo
        ? await det.resolve_coincidence(work, facts, coreIds, opts.repo, anchors!)
        : det.coimport_drop(work, facts, coreIds, anchors!);
      wiringPromise = hybridWiring(work, facts, llmOpts, drop, anchors!); // LLM draw + det grounding (async)
    }
  }

  // CLUSTERS. The LLM cluster pass is INDEPENDENT of wiring (it clusters from the diff, not the wire
  // graph), so when both are LLM we run reconcile ∥ cluster concurrently — the latency win. The det
  // cluster pass READS h.wires, so it must wait for wiring to finish first.
  if (cluster === "llm") {
    const clusterPromise = llm.assign_clusters(work, { ...llmOpts, structuralContext: opts.structuralContext });
    const [wres] = await Promise.all([wiringPromise ?? Promise.resolve(mergePlan), clusterPromise]);
    mergePlan = wres ?? mergePlan;
  } else {
    if (wiringPromise) mergePlan = await wiringPromise;               // det clustering reads the wires
    det.assign_clusters(work, facts);
    if (cluster === "hybrid") llm.label_clusters_llm(work, llmOpts);   // LLM prose labels over det groups
  }

  // SEAM MERGE — apply the plan (was a thunk closing over reconcile output; now explicit data).
  if (mergePlan?.kind === "det") det.merge_seams(work);
  else if (mergePlan?.kind === "hybrid") det.apply_seam_groups(work, mergePlan.labels, mergePlan.groups, true, facts);
  det.merge_clusters_by_intent(work);
  det.assign_spans(work, opts.repo);
}

// The hybrid wiring (LLM-first): the LLM groups cores into seams + draws each edit's line by
// meaning; determinism GROUNDS the draw and prunes the over-wired ungrounded ones.
async function hybridWiring(work: Hunk[], facts: Map<string, HunkFacts>,
                      llmOpts: { model?: string; claudeBin?: string | null },
                      drop: Map<string, Set<string>>,
                      anchors: Map<string, Set<string>>): Promise<MergePlan | null> {
  const cores = new Map<string, Hunk>();
  for (const h of work) if (h.role === "core") cores.set(h.id, h);
  const targets = work.filter((h) => h.role !== "core");
  if (!cores.size) return null;
  const coreIds = new Set(cores.keys());
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
  const { labels, groups, drawn } = await llm.reconcile_llm(cores, targets, hints, llmOpts);
  for (const h of targets) {
    const line = drawn.get(h.id);
    if (line === undefined) continue;
    const m = det._mentions(facts.get(h.id)!);
    const owned = new Set<string>();
    for (const c of cores.keys())
      if (intersect(intersect(anchors.get(c) ?? new Set(), m), facts.get(c)!.defines).size) owned.add(c);
    // Same-file grounding rung: a link/edit and a core in the SAME file that share a distinctive
    // symbol are a real structural coupling — the import-and-render of a component the core builds.
    // The `owned` test requires the core to DEFINE the shared symbol, which misses same-file
    // import→render couplings (the shared symbol is an external import the core renders but doesn't
    // define), so those edges would be marked `suggested` (dim) and the core read as isolated.
    // Grounding them by file co-location is the same-file mirror of det.resolve_coincidence's
    // cross-file import resolution — deterministic, and bounded (few cores per file).
    const sameFile = new Set<string>();
    for (const [cid, core] of cores)
      if (cid !== h.id && core.file_path === h.file_path && intersect(anchors.get(cid) ?? new Set(), m).size) sameFile.add(cid);
    const resolved = new Set(h.resolved_wires.filter((c) => coreIds.has(c)));
    const grounded = intersect(union(union(owned, resolved), sameFile), coreIds);
    const drawnSet = intersect(union(union(union(new Set(line), owned), resolved), sameFile), coreIds);
    const [kept, suggested] = det.grounded_prune(drawnSet, grounded);
    h.wires = sorted(kept);
    h.suggested_wires = sorted(suggested);
  }
  det.finalize_wiring(work); // hybrid wiring terminal: h.wires are final — the det cluster pass may now read them
  return { kind: "hybrid", labels, groups };   // the merge phase applies apply_seam_groups from this
}
