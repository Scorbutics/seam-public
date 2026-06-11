"""Per-pass classifier orchestrator — mix engines, one toggle each.

Each pass independently picks an engine — **det**, **llm**, or **hybrid** (deterministic
first, LLM reconciliation on the residual only):
  - cluster (product-intent grouping):
      det = connected components + structural labels;  llm = LLM grouping + prose labels;
      hybrid = deterministic grouping + LLM prose labels.
  - roles (core/link/environment/test):
      det (beats the LLM, ~0.77 vs ~0.55);  llm;  hybrid = det + LLM re-judges only the
      UNCERTAIN (low-confidence) hunks.
  - wiring (which core a hunk wires to):
      det (subject anchoring, F1 ~0.63 vs ~0.24);  llm;  hybrid = det + det-reconcile, then
      the INVERTED reconcile — the LLM NAMES the seams (technical intent) and DRAWS each
      over-wired hunk's line by MEANING, and determinism CONFRONTS the draw (keeps it + re-adds
      owned-symbol edges it missed). LLM-first, determinism-checks — the opposite of pruning.

DEFAULT: cluster=llm, roles=det, wiring=hybrid — LLM where it's the only reliable engine
(grouping), deterministic where it wins (roles), and deterministic-with-LLM-cleanup where
the deterministic tail over-wires (containers). On a focused diff the hybrid residual is
empty, so it costs nothing beyond the deterministic pass.

Passes run in DEPENDENCY ORDER — roles, then wiring (reads roles), then clusters.
"""
from __future__ import annotations

from src.core import progress

from . import classifier, classifier_det
from .facts import FactsProvider, RegexFactsProvider
from .parser import Hunk

ENGINES = ("llm", "det", "hybrid")
DEFAULTS = {"cluster": "llm", "roles": "det", "wiring": "hybrid"}


def classify(
    hunks: list[Hunk],
    *,
    cluster: str = "llm",
    roles: str = "det",
    wiring: str = "det",
    facts_provider: FactsProvider | None = None,
    model: str = "claude-haiku-4-5",
    claude_bin: str | None = None,
    context_window: int = 200_000,
    role_votes: int = classifier.ROLE_VOTES,
    verbose: bool = False,
    debug: bool = False,
    debug_path: str | None = None,
    repo: str | None = None,
) -> None:
    """Run each pass on its selected engine, in dependency order, mutating `hunks`."""
    # All-LLM → the optimized concurrent path (cluster ∥ roles, then wiring).
    if cluster == roles == wiring == "llm":
        progress.emit("Classifying roles, seams & intent with the LLM…")
        classifier.classify(hunks, model=model, claude_bin=claude_bin,
                            context_window=context_window, role_votes=role_votes,
                            verbose=verbose, debug=debug, debug_path=debug_path)
        live = [h for h in hunks if h.role != "noise"]
        classifier_det.merge_clusters_by_intent(live)   # collapse the LLM's duplicate-label clusters
        # Overlap placements are engine-agnostic (additive; never touch role/seam/wires).
        classifier_det.assign_spans(live, repo=repo)
        return

    work = [h for h in hunks if h.role != "noise"]
    if not work:
        return

    facts = None
    if any(p in ("det", "hybrid") for p in (cluster, roles, wiring)):
        progress.emit("Reading code facts…")
        facts = (facts_provider or RegexFactsProvider()).facts(work)
    llm = dict(model=model, claude_bin=claude_bin, verbose=verbose, debug=debug, debug_path=debug_path)

    # ROLES
    progress.emit("Classifying roles with the LLM…" if roles == "llm" else "Classifying roles…")
    if roles == "llm":
        classifier.assign_roles(work, role_votes=role_votes, **llm)
    else:
        classifier_det.assign_roles(work, facts)              # det base
        if roles == "hybrid":
            progress.emit("Re-judging uncertain roles with the LLM…")
            classifier.reconcile_roles_llm(work, **llm)        # LLM re-judges the uncertain
    # WIRING (reads roles). Seam MERGING is deferred until AFTER clustering: clusters are
    # connected components over the FULL core-level wires, and merging collapses wires onto a
    # representative (which would fragment the cluster graph). So wiring sets core-level wires
    # here; `_seam_merge` (a thunk) is applied post-cluster.
    _seam_merge = None
    progress.emit("Drawing seams with the LLM…" if wiring in ("llm", "hybrid") else "Wiring seams…")
    if wiring == "llm":
        classifier.assign_wiring(work, **llm)
    else:
        classifier_det.assign_wiring(work, facts)             # symbol candidates (the hint + grounding)
        if wiring == "det":
            classifier_det.reconcile_wiring(work, facts)      # deterministic owned-prune
            _seam_merge = lambda: classifier_det.merge_seams(work)   # same-component cores → seam
        else:  # hybrid — LLM-FIRST: the LLM draws the line, determinism grounds it.
            #  (1) the LLM GROUPS cores into technical-intent SEAMS (≥1 core each) + names them,
            #  (2) DRAWS each non-core hunk's dependency line BY MEANING, with the deterministic
            #      symbol candidates as a HINT; determinism GROUNDS the draw (re-adds owned-symbol
            #      edges it missed). No LLM list for a hunk → keep the deterministic candidates.
            cores = {h.id: h for h in work if h.role == "core"}
            targets = [h for h in work if h.role != "core"]
            if cores:
                hints = {h.id: list(h.wires) for h in targets}
                labels, groups, drawn = classifier.reconcile_llm(cores, targets, hints=hints, **llm)
                anchors = classifier_det._anchors(work, facts, set(cores))
                core_ids = set(cores)
                for h in targets:
                    line = drawn.get(h.id)
                    if line is None:
                        continue                               # LLM gave no list → keep det candidates
                    m = classifier_det._mentions(facts[h.id])
                    # STRICT grounding: `owned` = h references a symbol the core DEFINES (a real
                    # def↔ref), plus RESOLVED imports (Phase 4). NOT the broad subject floor — that's
                    # itself what hairballs on view files mentioning many component names.
                    owned = {c for c in cores if (anchors[c] & m) & facts[c].defines}
                    resolved = {c for c in getattr(h, "resolved_wires", ()) if c in cores}
                    grounded = (owned | resolved) & core_ids
                    drawn_set = (set(line) | owned | resolved) & core_ids
                    # ADAPTIVE PER-NODE PRUNE: keep every LLM edge on a sparse node (implicit/border
                    # couplings survive); on an OVER-wired node drop the ungrounded (topical) ones,
                    # keeping the grounded — a hub with no grounding is left intact. The surviving
                    # ungrounded edges are `suggested` (stamped LLM / rendered faint).
                    kept, suggested = classifier_det.grounded_prune(drawn_set, grounded)
                    h.wires = sorted(kept)
                    h.suggested_wires = sorted(suggested)
                # Defer the LLM's intent-grouping merge until after clustering (see above).
                # `facts` enables the symbol-disjointness floor (a big component's distinct
                # sub-intents stay split; same-symbol hunks merge).
                _seam_merge = lambda: classifier_det.apply_seam_groups(work, labels, groups, facts=facts)
    # CLUSTERS (reads the FULL wiring graph for the deterministic engine; independent for the LLM)
    progress.emit("Grouping by intent with the LLM…" if cluster in ("llm", "hybrid") else "Grouping by intent…")
    if cluster == "llm":
        classifier.assign_clusters(work, **llm)
    else:
        classifier_det.assign_clusters(work, facts)           # det grouping + structural labels
        if cluster == "hybrid":
            classifier.label_clusters_llm(work, **llm)         # LLM prose labels over det groups

    # SEAM MERGE (after clustering): collapse same-intent cores into multi-core seams.
    progress.emit("Laying out seams…")
    if _seam_merge is not None:
        _seam_merge()

    # Collapse clusters the LLM gave the SAME intent label (e.g. one 'Update global styles' per CSS
    # hunk) into one — a deterministic cleanup over `group`, no-op when labels are distinct.
    classifier_det.merge_clusters_by_intent(work)

    # SPANS / OVERLAP (reads roles + wiring) — per-seam sub-range placements + header peel.
    # Engine-agnostic and additive, so it's part of the classified state for every combo.
    classifier_det.assign_spans(work, repo=repo)

    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in classifier.ROLES if counts.get(r))
        print(f"[engine] cluster={cluster} roles={roles} wiring={wiring}: {summary}")
