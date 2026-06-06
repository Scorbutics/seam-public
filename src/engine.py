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
        classifier.classify(hunks, model=model, claude_bin=claude_bin,
                            context_window=context_window, role_votes=role_votes,
                            verbose=verbose, debug=debug, debug_path=debug_path)
        # Overlap placements are engine-agnostic (additive; never touch role/seam/wires).
        classifier_det.assign_spans([h for h in hunks if h.role != "noise"], repo=repo)
        return

    work = [h for h in hunks if h.role != "noise"]
    if not work:
        return

    facts = None
    if any(p in ("det", "hybrid") for p in (cluster, roles, wiring)):
        facts = (facts_provider or RegexFactsProvider()).facts(work)
    llm = dict(model=model, claude_bin=claude_bin, verbose=verbose, debug=debug, debug_path=debug_path)

    # ROLES
    if roles == "llm":
        classifier.assign_roles(work, role_votes=role_votes, **llm)
    else:
        classifier_det.assign_roles(work, facts)              # det base
        if roles == "hybrid":
            classifier.reconcile_roles_llm(work, **llm)        # LLM re-judges the uncertain
    # WIRING (reads roles)
    if wiring == "llm":
        classifier.assign_wiring(work, **llm)
    else:
        classifier_det.assign_wiring(work, facts)             # symbol candidates (the hint + grounding)
        if wiring == "det":
            classifier_det.reconcile_wiring(work, facts)      # deterministic owned-prune
        else:  # hybrid — LLM-FIRST: the LLM draws the line, determinism grounds it.
            #  (1) the LLM NAMES every seam (technical intent), and
            #  (2) DRAWS each non-core hunk's dependency line BY MEANING, given the deterministic
            #      symbol candidates only as a HINT; then determinism GROUNDS the draw — keep the
            #      LLM's line and re-add any OWNED-symbol edge it missed. No LLM list for a hunk
            #      → keep the deterministic candidates (don't strand).
            cores = {h.id: h for h in work if h.role == "core"}
            targets = [h for h in work if h.role != "core"]
            if cores:
                hints = {h.id: list(h.wires) for h in targets}
                labels, drawn = classifier.reconcile_llm(cores, targets, hints=hints, **llm)
                for cid, lab in labels.items():
                    cores[cid].seam_label = lab                # LLM-named seam (technical intent)
                anchors = classifier_det._anchors(work, facts, set(cores))
                for h in targets:
                    line = drawn.get(h.id)
                    if line is None:
                        continue                               # LLM gave no list → keep det candidates
                    m = classifier_det._mentions(facts[h.id])
                    owned = {c for c in cores if (anchors[c] & m) & facts[c].defines}
                    h.wires = sorted(set(line) | owned)        # LLM line (primary) + det owned (grounding)
    # CLUSTERS (reads wiring for the deterministic engine; independent for the LLM)
    if cluster == "llm":
        classifier.assign_clusters(work, **llm)
    else:
        classifier_det.assign_clusters(work, facts)           # det grouping + structural labels
        if cluster == "hybrid":
            classifier.label_clusters_llm(work, **llm)         # LLM prose labels over det groups

    # SPANS / OVERLAP (reads roles + wiring) — per-seam sub-range placements + header peel.
    # Engine-agnostic and additive, so it's part of the classified state for every combo.
    classifier_det.assign_spans(work, repo=repo)

    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in classifier.ROLES if counts.get(r))
        print(f"[engine] cluster={cluster} roles={roles} wiring={wiring}: {summary}")
