"""GraphIR contract gate — the regression suite for the SHARED BARÈBONE (plan §1.1 / D6).

GraphIR is the mode-agnostic graph both fronts (diff hunks today, codebase resolver
tomorrow) feed into. These tests pin the two things that make the barebone trustworthy:

  1. THE INVARIANT (plan §1 / constraint §7.1): only RESOLVED edges may enter a
     completeness-bearing op. `assert_resolved_only` must RAISE on a non-resolved edge
     and pass on a resolved one — the spine that keeps the ignorance map honest.
  2. THE DIFF FRONT IS LOSSLESS: projecting the diff pipeline's labeled hunks via
     `from_hunks` and recomputing the Layer-4 partition with `connected_components`
     reproduces EXACTLY the `group` the engine assigned — proof the IR captures the
     diff graph (the "coupling is loose" check), run on every real case.

    .venv/bin/python -m pytest eval/graph_ir_test.py -q
"""
from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src.diff import classifier_det, noise_filter, parser
from src.diff.facts import RegexFactsProvider  # noqa: E402
from src.core.graph_ir import (  # noqa: E402
    RESOLVED, Edge, Provenance, ResolvedOnlyViolation, assert_resolved_only,
    connected_components, from_hunks,
)
from src.diff.parser import Hunk  # noqa: E402

CASES_DIR = Path(__file__).resolve().parent / "cases"


def _hunk(hid: str, role: str, *, seam: str = "", wires: list[str] | None = None) -> Hunk:
    """Minimal labeled Hunk for graph-shape tests (no diff text needed)."""
    return Hunk(id=hid, file_path="a.ts", source_file="a/a.ts", target_file="b/a.ts",
                change_type="modify", section_header="", text="", role=role,
                seam=seam, wires=list(wires or []))


# --------------------------------------------------------------------------- the invariant
def test_assert_resolved_only_raises_on_non_resolved():
    for prov in (Provenance.HEUR, Provenance.SUGGESTED, Provenance.LLM):
        with pytest.raises(ResolvedOnlyViolation):
            assert_resolved_only([Edge("a", "b", provenance=prov)])


def test_assert_resolved_only_passes_on_resolved():
    edges = [Edge("a", "b", provenance=Provenance.RESOLVED_FULL),
             Edge("b", "c", provenance=Provenance.RESOLVED_PARTIAL)]
    assert_resolved_only(edges)  # must not raise


def test_provenance_is_resolved_flag():
    assert Provenance.RESOLVED_FULL.is_resolved
    assert Provenance.RESOLVED_PARTIAL.is_resolved
    assert not Provenance.HEUR.is_resolved
    assert not Provenance.SUGGESTED.is_resolved
    assert not Provenance.LLM.is_resolved
    assert RESOLVED == {Provenance.RESOLVED_FULL, Provenance.RESOLVED_PARTIAL}


# --------------------------------------------------------------------------- clustering op
def test_connected_components_numbering_and_isolates():
    # n1-n2 joined; n3 joined to n2 transitively; n4 isolated → its own singleton.
    groups = connected_components(["n1", "n2", "n3", "n4"],
                                  [("n1", "n2"), ("n3", "n2")])
    assert groups["n1"] == groups["n2"] == groups["n3"] == "g1"
    assert groups["n4"] == "g2"            # isolated node → orphan singleton


def test_connected_components_ignores_dangling_endpoints():
    # an edge to a node not in the set is ignored (no KeyError, no phantom merge).
    groups = connected_components(["n1", "n2"], [("n1", "ghost"), ("n1", "n2")])
    assert groups["n1"] == groups["n2"] == "g1"


# --------------------------------------------------------------------------- diff front is lossless
def _partition_pairs(groups: dict[str, str]) -> set[tuple[str, str]]:
    """Same-cluster pairs — permutation-invariant identity of a partition."""
    return {(a, b) for a, b in combinations(sorted(groups), 2) if groups[a] == groups[b]}


def test_from_hunks_seam_comembership_groups_unwired_cores():
    """Two cores sharing a seam but with NO wiring path must still land in one cluster —
    the seam-comembership edge `merge_seams` adds. A third, unrelated core stays apart."""
    # seam id == the anchoring core's own id (engine convention); a merged seam reuses the
    # representative core's id, so h1 and h2 both carry seam "h1".
    hunks = [_hunk("h1", "core", seam="h1"), _hunk("h2", "core", seam="h1"),
             _hunk("h3", "core", seam="h3"),
             _hunk("h4", "link", wires=["h3"])]
    g = from_hunks(hunks)
    groups = connected_components(g.order(), [(e.src, e.dst) for e in g.edges])
    assert groups["h1"] == groups["h2"]            # merged seam → one cluster
    assert groups["h1"] != groups["h3"]            # distinct seam → distinct cluster
    assert groups["h3"] == groups["h4"]            # link wired to h3's seam joins it


@pytest.mark.parametrize("case", sorted(p.stem for p in CASES_DIR.glob("*.patch")))
def test_from_hunks_reproduces_clustering_partition(case):
    """The IR is a lossless substrate for the shared Layer-4 op: on every real case,
    `from_hunks` + `connected_components` reproduce EXACTLY the partition the engine's
    `assign_clusters` produced. Checked at clustering time (before `merge_seams`, a diff-
    specific post-process that mutates `group` outside pure connectivity)."""
    hunks = parser.parse((CASES_DIR / f"{case}.patch").read_text(encoding="utf-8"))
    noise_filter.classify(hunks)
    work = [h for h in hunks if h.role != "noise"]
    facts = RegexFactsProvider().facts(work)
    classifier_det.assign_roles(work, facts)
    classifier_det.assign_wiring(work, facts)
    classifier_det.reconcile_wiring(work, facts)
    classifier_det.assign_clusters(work, facts)    # the engine's partition (pre-merge)

    g = from_hunks(work)
    # every working hunk is a node; diff edges carry a NON-resolved provenance (the diff
    # product makes no completeness promise — plan §2) so the invariant guard rejects them.
    assert set(g.nodes) == {h.id for h in work}
    assert all(not e.provenance.is_resolved for e in g.edges)
    if g.edges:
        with pytest.raises(ResolvedOnlyViolation):
            assert_resolved_only(g.edges)

    recomputed = connected_components(g.order(), [(e.src, e.dst) for e in g.edges])
    engine_groups = {h.id: h.group for h in work}
    assert _partition_pairs(recomputed) == _partition_pairs(engine_groups)
