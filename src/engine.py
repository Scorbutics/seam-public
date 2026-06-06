"""Per-pass classifier orchestrator — mix LLM and deterministic engines, one toggle each.

The three passes are independent levers:
  - cluster  (product-intent grouping)  — default **llm** (the only reliable way; the
             deterministic connected-components grouping loses badly, ~0.68 vs ~0.98)
  - roles    (core/link/environment/test) — default **det** (beats the LLM, ~0.77 vs ~0.55)
  - wiring   (which core a hunk wires to)  — default **det** (beats the LLM, F1 ~0.63 vs ~0.24)

So the DEFAULT is a HYBRID: LLM clusters + deterministic roles + deterministic wiring —
each pass on the engine the eval showed is better. Any pass can be flipped independently.

Passes run in DEPENDENCY ORDER — roles, then wiring (reads roles), then clusters — so an
engine swap on one pass never breaks another: the deterministic wiring reads whatever set
the roles, the deterministic clusters read whatever set the wiring.
"""
from __future__ import annotations

from . import classifier, classifier_det
from .facts import FactsProvider, RegexFactsProvider
from .parser import Hunk

ENGINES = ("llm", "det")
DEFAULTS = {"cluster": "llm", "roles": "det", "wiring": "det"}


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
) -> None:
    """Run each pass on its selected engine, in dependency order, mutating `hunks`."""
    # All-LLM → the optimized concurrent path (cluster ∥ roles, then wiring).
    if cluster == roles == wiring == "llm":
        classifier.classify(hunks, model=model, claude_bin=claude_bin,
                            context_window=context_window, role_votes=role_votes,
                            verbose=verbose, debug=debug, debug_path=debug_path)
        return

    work = [h for h in hunks if h.role != "noise"]
    if not work:
        return

    facts = None
    if "det" in (cluster, roles, wiring):
        facts = (facts_provider or RegexFactsProvider()).facts(work)
    llm = dict(model=model, claude_bin=claude_bin, verbose=verbose, debug=debug, debug_path=debug_path)

    # ROLES
    if roles == "det":
        classifier_det.assign_roles(work, facts)
    else:
        classifier.assign_roles(work, role_votes=role_votes, **llm)
    # WIRING (reads roles)
    if wiring == "det":
        classifier_det.assign_wiring(work, facts)
    else:
        classifier.assign_wiring(work, **llm)
    # CLUSTERS (reads wiring for the deterministic engine; independent for the LLM)
    if cluster == "det":
        classifier_det.assign_clusters(work, facts)
    else:
        classifier.assign_clusters(work, **llm)

    if verbose:
        counts: dict[str, int] = {}
        for h in work:
            counts[h.role] = counts.get(h.role, 0) + 1
        summary = "  ".join(f"{r}={counts.get(r, 0)}" for r in classifier.ROLES if counts.get(r))
        print(f"[engine] cluster={cluster} roles={roles} wiring={wiring}: {summary}")
