"""Tests for the deterministic import-scan consumer-discovery front (src/import_scan.py).

CI-safe: runs against the synthetic mini-monorepo in eval/fixtures/scan_repo (no cal.com).
Validates the Phase-0 pivot's machinery — recall by named imports, the resolved/suggested/
excluded honesty split, and tree-sitter per-site enclosing-symbol resolution.
"""
import os

import pytest

from src import import_scan
from src.atoms import available

REPO = os.path.join(os.path.dirname(__file__), "fixtures", "scan_repo")
ANCHOR = "packages/lib/widget.ts"
SYM = "makeWidget"


def _by_file(consumers):
    return {c.file.replace("\\", "/"): c.status for c in consumers}


def test_module_resolution_package_and_relative():
    pkgs = import_scan._pkg_map(REPO)
    assert pkgs.get("@demo/lib", "").replace("\\", "/") == "packages/lib"
    assert pkgs.get("@demo/web", "").replace("\\", "/") == "apps/web"
    # cross-package import resolves to the anchor file
    r = import_scan.resolve_module(REPO, "apps/web/consumer.ts", "@demo/lib/widget", pkgs)
    assert r and r.replace("\\", "/") == "packages/lib/widget.ts"
    # relative import resolves to the anchor file
    r2 = import_scan.resolve_module(REPO, "packages/lib/sibling.ts", "./widget", pkgs)
    assert r2 and r2.replace("\\", "/") == "packages/lib/widget.ts"
    # unresolvable alias → None
    assert import_scan.resolve_module(REPO, "apps/web/aliased.ts", "~/widget", pkgs) is None


def test_scan_classifies_resolved_suggested_excluded():
    by_file = _by_file(import_scan.scan_consumers(REPO, ANCHOR, SYM))
    # RESOLVED: cross-package, relative, class-method, module-level
    for f in ("apps/web/consumer.ts", "apps/web/service.ts", "apps/web/toplevel.ts",
              "packages/lib/sibling.ts"):
        assert by_file.get(f) == "resolved", f
    # SUGGESTED: unresolvable alias whose basename matches
    assert by_file.get("apps/web/aliased.ts") == "suggested"
    # EXCLUDED: imports a same-named symbol that resolves to a DIFFERENT file
    assert "apps/web/decoy.ts" not in by_file
    # the anchor file's own def and the decoy target are never consumers
    assert "packages/lib/widget.ts" not in by_file
    assert "apps/web/other.ts" not in by_file


def test_build_resolved_graph_shape():
    g = import_scan.build_resolved_graph(REPO, ANCHOR, SYM)
    assert g["resolutionQuality"] == "FULL"
    anchor = next(n for n in g["nodes"] if n["id"] == "n1")
    assert anchor["symbol"] == SYM and anchor["file"] == ANCHOR
    # every resolved edge points at the anchor and is RESOLVED_FULL
    assert g["edges"] and all(e["to"] == "n1" and e["provenance"] == "RESOLVED_FULL" for e in g["edges"])
    # the suggested (unresolvable) consumer is a blind spot, NOT a resolved edge
    assert len(g["blindspots"]) == 1
    assert "aliased.ts" in g["blindspots"][0]["evidence"]
    bs_files = {n["file"].replace("\\", "/") for n in g["nodes"]}
    assert "apps/web/aliased.ts" not in bs_files       # suggested never becomes a node/edge
    assert "apps/web/decoy.ts" not in bs_files          # excluded never appears


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_anchor_def_resolved_by_treesitter():
    g = import_scan.build_resolved_graph(REPO, ANCHOR, SYM)
    anchor = next(n for n in g["nodes"] if n["id"] == "n1")
    assert anchor["kind"] == "function"
    assert anchor["range"][1] > anchor["range"][0]      # a real multi-line span, not [0,0]


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_depth2_ripple_adds_consumers_of_consumers():
    g1 = import_scan.build_resolved_graph(REPO, ANCHOR, SYM, depth=1)
    g2 = import_scan.build_resolved_graph(REPO, ANCHOR, SYM, depth=2)
    files1 = {n["file"].replace("\\", "/") for n in g1["nodes"]}
    files2 = {n["file"].replace("\\", "/") for n in g2["nodes"]}
    # page-host.ts imports the EXPORTED depth-1 consumer renderPage → only appears at depth 2
    assert "apps/web/page-host.ts" not in files1
    assert "apps/web/page-host.ts" in files2
    # the ripple node wires to the renderPage CONSUMER node, not to the anchor (it's depth-2)
    host = next(n for n in g2["nodes"] if n["file"].replace("\\", "/") == "apps/web/page-host.ts")
    renderpage = next(n for n in g2["nodes"] if n["symbol"] == "renderPage")
    e2 = {(e["from"], e["to"]) for e in g2["edges"]}
    assert (host["id"], renderpage["id"]) in e2
    assert (host["id"], "n1") not in e2


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_depth2_node_is_environment_boundary():
    from src import codebase, graph_ir
    g = graph_ir.from_resolved_graph(import_scan.build_resolved_graph(REPO, ANCHOR, SYM, depth=2))
    codebase.decompose(g)
    host = next(n for n in g.nodes.values() if n.file.replace("\\", "/") == "apps/web/page-host.ts")
    assert host.role == "environment"      # depth-2 = the boundary frontier
    # direct consumers stay link (in-footprint)
    rp = next(n for n in g.nodes.values() if n.label == "renderPage")
    assert rp.role == "link"


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_module_mode_members_and_cooccurrence():
    g = import_scan.build_module_graph(REPO, ANCHOR)
    members = {n["symbol"]: n for n in g["nodes"] if n["enclosing"] == "widget"}
    # all three exports become carriers (function, const, function)
    assert set(members) == {"makeWidget", "WIDGET_KIND", "makeOrphan"}
    assert g["anchor"]["id"] == "mod" and g["anchor"]["symbol"] == "widget"
    # consumer.ts imports BOTH makeWidget and WIDGET_KIND → edges to both (the co-occurrence signal)
    edges_from = {}
    for e in g["edges"]:
        edges_from.setdefault(e["from"], set()).add(e["to"])
    consumer_nodes = {n["id"]: n for n in g["nodes"] if n["id"].startswith("c")}
    cons_by_file = {n["file"].replace("\\", "/"): nid for nid, n in consumer_nodes.items()}
    assert edges_from[cons_by_file["apps/web/consumer.ts"]] == {"makeWidget", "WIDGET_KIND"}
    # makeOrphan has no consumer → appears as a member node but no incoming edge
    assert "makeOrphan" not in {t for ts in edges_from.values() for t in ts}


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_module_mode_decomposes_with_cooccurrence_seam():
    # end-to-end: the floor should fuse makeWidget + WIDGET_KIND (co-used by consumer.ts) into ONE
    # seam, and leave makeOrphan isolated.
    from src import codebase, graph_ir
    g = graph_ir.from_resolved_graph(import_scan.build_module_graph(REPO, ANCHOR))
    model = codebase.decompose(g)
    seam_of = {}
    for cl in model["clusters"]:
        for s in cl["seams"]:
            for h in s["hunks"]:
                if h["id"] in ("makeWidget", "WIDGET_KIND", "makeOrphan"):
                    seam_of.setdefault(h["id"], s["id"])
    assert seam_of["makeWidget"] == seam_of["WIDGET_KIND"]          # co-occurrence fused them
    assert seam_of["makeOrphan"] != seam_of["makeWidget"]          # orphan stays separate


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_enclosing_symbol_resolution():
    g = import_scan.build_resolved_graph(REPO, ANCHOR, SYM)
    nodes = {n["file"].replace("\\", "/"): n for n in g["nodes"] if n["id"] != "n1"}
    # function enclosing
    assert nodes["apps/web/consumer.ts"]["symbol"] == "renderPage"
    assert nodes["apps/web/consumer.ts"]["kind"] == "function"
    # class-method enclosing + the class recorded in `enclosing`
    svc = nodes["apps/web/service.ts"]
    assert svc["symbol"] == "build" and svc["kind"] == "method" and svc["enclosing"] == "Svc"
    # module-level use → the file is the consumer (kind module)
    assert nodes["apps/web/toplevel.ts"]["kind"] == "module"
