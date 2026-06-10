"""Tests for graph merge + multi-anchor roles (src/expand.py, P2 foundation)."""
from src.codebase import codebase, expand
from src.core import graph_ir


def _base():
    return {
        "version": 1, "anchor": {"id": "n1", "symbol": "A", "file": "a.ts", "range": [0, 10]},
        "language": "typescript", "resolutionQuality": "FULL", "depth": 1, "complete": True,
        "nodes": [
            {"id": "n1", "symbol": "A", "kind": "function", "file": "a.ts", "range": [0, 10], "enclosing": "", "complexity": 10},
            {"id": "n2", "symbol": "C1", "kind": "function", "file": "c1.ts", "range": [5, 8], "enclosing": "", "complexity": 3},
        ],
        "edges": [{"from": "n2", "to": "n1", "kind": "reference", "provenance": "RESOLVED_FULL"}],
        "blindspots": [], "unresolved": [],
    }


def _add():
    # expanding C1: C1 is the anchor (note a DIFFERENT id m1, SAME file/line as base's n2) + its consumer C2
    return {
        "version": 1, "anchor": {"id": "m1", "symbol": "C1", "file": "c1.ts", "range": [5, 8]},
        "language": "typescript", "resolutionQuality": "FULL", "depth": 1, "complete": True,
        "nodes": [
            {"id": "m1", "symbol": "C1", "kind": "function", "file": "c1.ts", "range": [5, 8], "enclosing": "", "complexity": 3},
            {"id": "m2", "symbol": "C2", "kind": "function", "file": "c2.ts", "range": [3, 6], "enclosing": "", "complexity": 3},
        ],
        "edges": [{"from": "m2", "to": "m1", "kind": "reference", "provenance": "RESOLVED_FULL"}],
        "blindspots": [], "unresolved": [],
    }


def test_merge_dedups_shared_node_and_accumulates_anchors():
    merged = expand.merge_resolved(_base(), _add(), expand_anchor="m1")
    # C1 (same file/line in both) deduped → exactly one c1.ts node; C2 added → 3 total
    assert sum(1 for n in merged["nodes"] if n["file"] == "c1.ts") == 1
    assert any(n["file"] == "c2.ts" for n in merged["nodes"])
    assert len(merged["nodes"]) == 3
    # anchors accumulated: original A (n1) + the expanded C1 (deduped to n2)
    assert merged["anchors"] == ["n1", "n2"]
    # the C2→C1 edge is remapped onto the SURVIVING C1 id (n2), not the dropped m1
    c2 = next(n["id"] for n in merged["nodes"] if n["file"] == "c2.ts")
    assert {(e["from"], e["to"]) for e in merged["edges"]} == {("n2", "n1"), (c2, "n2")}


def test_merge_is_idempotent_on_repeat():
    once = expand.merge_resolved(_base(), _add(), expand_anchor="m1")
    twice = expand.merge_resolved(once, _add(), expand_anchor="m1")
    assert len(twice["nodes"]) == len(once["nodes"])      # re-merging adds nothing new
    assert len(twice["edges"]) == len(once["edges"])


def test_multi_anchor_roles_promote_expanded_node_to_core():
    merged = expand.merge_resolved(_base(), _add(), expand_anchor="m1")
    g = graph_ir.from_resolved_graph(merged)
    codebase.decompose(g)
    roles = {n.label: n.role for n in g.nodes.values()}
    assert roles["A"] == "core"        # the original anchor
    assert roles["C1"] == "core"       # was a link; expanding promotes it to a sub-anchor/core
    assert roles["C2"] == "link"       # the newly reached consumer of C1


def test_expansion_stacks_anchors_into_distinct_seams():
    # A (n1) and the expanded C1 (n2) are distinct hops of the grown chain → DISTINCT seams, STACKED,
    # not fused. The cross-anchor core→core edge survives as a seam CONTRACT (the chain link).
    merged = expand.merge_resolved(_base(), _add(), expand_anchor="m1")
    g = graph_ir.from_resolved_graph(merged)
    model = codebase.decompose(g)
    seam_of = {}
    for cl in model["clusters"]:
        for s in cl["seams"]:
            for h in s["hunks"]:
                if h["id"] in ("n1", "n2"):    # A and C1 (the two anchors)
                    seam_of[h["id"]] = s["id"]
    assert seam_of.get("n1") and seam_of.get("n2") and seam_of["n1"] != seam_of["n2"]   # stacked, not fused
    pair = {(c["seamA"], c["seamB"]) for c in model.get("seamContracts", [])}
    assert (seam_of["n1"], seam_of["n2"]) in pair or (seam_of["n2"], seam_of["n1"]) in pair
