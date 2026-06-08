"""Codebase-mode gate — pins the anchor-relative decomposition (plan §3) END-TO-END.

The SymbolResolver front (VSCode language APIs) can only be validated in the extension
host (F5). Everything DOWNSTREAM of its JSON contract — ingestion, role BFS, clustering,
well-formedness, emit — is pure and pinned here against a hand-built `ResolvedGraph`
fixture, so the engine is provable without the editor:

    .venv/bin/python -m pytest eval/codebase_test.py -q

What it locks:
  - the §1 invariant survives ingestion: SUGGESTED candidates stay OUT of `edges`;
    `unresolved` (UNKNOWN ≠ []) is preserved, never read as "no link".
  - anchor-relative roles: anchor + its members → core; boundary node → link; depth-2 →
    environment; test node → test.
  - well-formedness over RESOLVED edges only: the DI-wired member is an isolated-core
    (a TRUE shadow surfaced honestly, with its blind spot).
  - emit drops nothing: every reached node lands in a seam (cores or ambient ripple).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from src import codebase, graph_ir  # noqa: E402
from src.graph_ir import Provenance, assert_resolved_only  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "resolved-graph-sample.json"


@pytest.fixture
def g() -> graph_ir.Graph:
    return graph_ir.from_resolved_graph(json.loads(FIXTURE.read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- ingestion / invariant
def test_ingestion_keeps_suggested_out_of_edges(g):
    assert all(e.provenance.is_resolved for e in g.edges)        # edges[] is resolved-only
    assert_resolved_only(g.edges)                                # the spine holds
    # the DI candidate is a blind spot, NEVER a resolved edge.
    assert g.blindspots and g.blindspots[0].mechanism == "DI"
    assert all(c.provenance is Provenance.SUGGESTED for c in g.blindspots[0].candidates)
    assert all(e.dst != "StripeGateway" for e in g.edges)        # not minted as an edge


def test_unknown_is_not_empty(g):
    # an unresolved query is recorded as UNKNOWN, distinct from "no link".
    assert g.unresolved and g.unresolved[0]["node"] == "n8"
    assert g.anchor == "n1" and g.resolution_quality == "FULL"


# --------------------------------------------------------------------------- roles (Layer 3)
def test_anchor_relative_roles(g):
    codebase.assign_roles(g)
    role = {n.id: n.role for n in g.nodes.values()}
    assert role["n1"] == "core"            # anchor
    assert role["n2"] == role["n3"] == role["n8"] == "core"   # its members
    assert role["n4"] == "link"            # boundary node wired to cores
    assert role["n6"] == "environment"     # depth-2, reached only via the link
    assert role["n7"] == "test"            # verification node


# --------------------------------------------------------------------------- well-formedness (Layer 6)
def test_isolated_core_is_surfaced(g):
    codebase.assign_roles(g)
    health = graph_ir.wellformedness(g)
    # n8 (DI-wired) has no resolved link → an honest isolated-core shadow.
    assert "isolated-core" in health["seam_warnings"].get("n8", [])
    assert health["postures"]["isolated_cores"] == 1
    assert health["postures"]["unresolved"] == 1
    assert health["postures"]["blindspots"] == 1


def test_wellformedness_rejects_non_resolved_edges(g):
    codebase.assign_roles(g)
    g.edges.append(graph_ir.Edge("n2", "n6", provenance=Provenance.LLM))
    with pytest.raises(graph_ir.ResolvedOnlyViolation):
        graph_ir.wellformedness(g)         # an LLM edge must never reach the resolved op


# --------------------------------------------------------------------------- emit (end-to-end)
def test_emit_drops_no_reached_node(g):
    model = codebase.decompose(g)
    rendered = {h["id"] for cl in model["clusters"] for s in cl["seams"] for h in s["hunks"]}
    rendered |= {h["id"] for h in model["tests"]}
    assert rendered == set(g.nodes)        # nothing reached is silently dropped

    assert model["mode"] == "codebase"
    assert model["resolutionQuality"] == "FULL"
    assert model["anchor"] == "n1"
    assert model["blindspots"][0]["mechanism"] == "DI"
    # the anchor + members cluster together (containment edges), n4/n6 join via calls.
    assert len(model["clusters"]) == 1
    # the isolated-core warning rides on n8's seam.
    n8_seam = next(s for cl in model["clusters"] for s in cl["seams"] if s["id"] == "n8")
    assert "isolated-core" in n8_seam["warnings"]


def test_link_appears_in_multiple_seams(g):
    model = codebase.decompose(g)
    seams_with_n4 = [s["id"] for cl in model["clusters"] for s in cl["seams"]
                     if any(h["id"] == "n4" for h in s["hunks"])]
    assert set(seams_with_n4) == {"n2", "n3"}   # many-to-many: the gateway wires both
