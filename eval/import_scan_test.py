"""Tests for the deterministic import-scan consumer-discovery front (src/import_scan.py).

CI-safe: runs against the synthetic mini-monorepo in eval/fixtures/scan_repo (no cal.com).
Validates the Phase-0 pivot's machinery — recall by named imports, the resolved/suggested/
excluded honesty split, and tree-sitter per-site enclosing-symbol resolution.
"""
import os

import pytest

from src.codebase import import_scan
from src.codebase.atoms import available

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


CLS_ANCHOR = "packages/lib/payments.ts"
CLS = "PaymentService"


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_class_mode_method_attribution():
    g = import_scan.build_class_graph(REPO, CLS_ANCHOR, CLS)
    members = {n["symbol"] for n in g["nodes"] if n["enclosing"] == CLS}
    # only PARTICIPATING methods are carriers; `unused` is summarised, not a node
    assert members == {"charge", "refund", "validate"}
    assert "unused" not in members
    edges_from = {}
    for e in g["edges"]:
        if e["from"].startswith("c"):
            edges_from.setdefault(e["from"], set()).add(e["to"])
    by_file = {n["file"].replace("\\", "/"): n["id"] for n in g["nodes"] if n["id"].startswith("c")}
    mid = lambda m: f"{CLS}.{m}"
    # each receiver form attributes the right method(s):
    assert edges_from[by_file["apps/web/checkout.ts"]] == {mid("charge"), mid("refund")}   # new X()
    assert edges_from[by_file["apps/web/admin.ts"]] == {mid("validate")}                    # typed param
    assert edges_from[by_file["apps/web/di.ts"]] == {mid("charge")}                         # this.field DI
    # the receiver is a TYPE-CHECKED reference to the class — `new X()`, a `: X`-typed param, or a
    # `: X` DI field — so all three attributions are RESOLVED (certain), not a guess. (An UNTYPED
    # name-only match doesn't reach here; that's the call-site scan's RESOLVED_PARTIAL.)
    prov = {}
    for e in g["edges"]:
        if e["from"].startswith("c") and e["to"] != CLS:
            prov.setdefault(e["from"], set()).add(e["provenance"])
    assert prov[by_file["apps/web/checkout.ts"]] == {"RESOLVED_FULL"}     # new PaymentService()
    assert prov[by_file["apps/web/admin.ts"]] == {"RESOLVED_FULL"}        # ps: PaymentService param
    assert prov[by_file["apps/web/di.ts"]] == {"RESOLVED_FULL"}           # this.payments: PaymentService


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_callsite_graph_finds_method_callsites_regardless_of_import():
    # repo-wide `.method(` discovery: charge/refund/validate are called in checkout.ts/admin.ts/di.ts
    g = import_scan.build_callsite_graph(REPO, CLS_ANCHOR, CLS)
    files = {n["file"].replace("\\", "/") for n in g["nodes"] if n["id"] != "n1"}
    assert "apps/web/checkout.ts" in files    # ps.charge() / ps.refund()
    assert "apps/web/admin.ts" in files        # ps.validate()
    assert "apps/web/di.ts" in files           # this.payments.charge()
    method_edges = [e for e in g["edges"] if e["to"] == "n1"]
    assert method_edges and all(e["provenance"] == "RESOLVED_PARTIAL" for e in method_edges)


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_dependency_graph_downward_finds_behavioural_deps_as_links():
    # DOWNWARD: checkout.ts imports the PaymentService CLASS → a dependency that is NOT added to
    # `anchors`, so on merge it becomes WIRING (a link adjacent to the now-core source), not a new
    # core — following a dependency keeps the core set the deliberate focus (no all-core flattening).
    g = import_scan.build_dependency_graph(REPO, "apps/web/checkout.ts", "checkout")
    dep = next((n for n in g["nodes"] if n["symbol"] == "PaymentService"), None)
    assert dep is not None and dep["kind"] == "class"
    assert dep["id"] not in g["anchors"]                               # not a core; the source (n1) is
    assert any(e["from"] == "n1" and e["to"] == dep["id"] and e["kind"] == "import" for e in g["edges"])


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_class_call_candidates_for_lsp_verification():
    cands = import_scan.class_call_candidates(REPO, CLS_ANCHOR, CLS)
    got = {(c["file"].replace("\\", "/").split("/")[-1], c["method"]) for c in cands}
    # every method call-site (ANY receiver — incl. the this.field DI in di.ts) is emitted for the
    # extension to verify; positions present
    assert ("checkout.ts", "charge") in got and ("checkout.ts", "refund") in got
    assert ("admin.ts", "validate") in got
    assert ("di.ts", "charge") in got
    assert all(isinstance(c["line"], int) and isinstance(c["col"], int) for c in cands)


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_verified_attribution_is_additive_and_loses_no_consumer():
    # LSP verifies ONLY checkout; di/admin fall back to the typed/newed heuristic — ALL RESOLVED (each
    # receiver is a type-checked reference to the class), and NONE is lost (LSP is additive precision,
    # never a replacement). Both with and without the LSP, class-mode attribution is RESOLVED.
    def provs(g):
        by = {n["file"].replace("\\", "/"): n["id"] for n in g["nodes"] if n["id"].startswith("c")}
        p = {}
        for e in g["edges"]:
            if e["from"].startswith("c") and "." in e["to"]:
                p.setdefault(e["from"], set()).add(e["provenance"])
        return {f: p.get(i, set()) for f, i in by.items()}
    files = ("apps/web/checkout.ts", "apps/web/di.ts", "apps/web/admin.ts")
    with_lsp = provs(import_scan.build_class_graph(REPO, CLS_ANCHOR, CLS,
                                                   verified={"apps/web/checkout.ts": {"charge": 5, "refund": 6}}))
    offline = provs(import_scan.build_class_graph(REPO, CLS_ANCHOR, CLS))
    for f in files:                                  # every traced consumer present + RESOLVED, both ways
        assert with_lsp[f] == {"RESOLVED_FULL"}
        assert offline[f] == {"RESOLVED_FULL"}


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_class_mode_untraced_and_unused_blindspots():
    g = import_scan.build_class_graph(REPO, CLS_ANCHOR, CLS)
    ev = " ".join(b["evidence"] for b in g["blindspots"])
    assert "registry.ts" in ev                 # imports the class, no traced method → untraced blind spot
    assert "unused" in ev                       # the unused method → summary coverage note
    # the untraced consumer wired to the CLASS (not dropped), as RESOLVED_FULL
    assert any(e["to"] == CLS and e["provenance"] == "RESOLVED_FULL" for e in g["edges"])


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_class_mode_cooccurrence_and_delegation():
    from src.codebase import codebase
    from src.core import graph_ir
    # build_resolved_graph DELEGATES to class mode for a class anchor
    g = graph_ir.from_resolved_graph(import_scan.build_resolved_graph(REPO, CLS_ANCHOR, CLS))
    model = codebase.decompose(g)
    seam_of = {}
    for cl in model["clusters"]:
        for s in cl["seams"]:
            for h in s["hunks"]:
                if h["id"] in (f"{CLS}.charge", f"{CLS}.refund", f"{CLS}.validate"):
                    seam_of[h["id"]] = s["id"]
    # charge + refund co-occur (checkout uses both) → same seam; validate (admin only) → separate
    assert seam_of[f"{CLS}.charge"] == seam_of[f"{CLS}.refund"]
    assert seam_of[f"{CLS}.validate"] != seam_of[f"{CLS}.charge"]


@pytest.mark.skipif(not available(), reason="tree-sitter not installed")
def test_test_file_consumer_gets_test_role():
    from src.codebase import codebase
    from src.core import graph_ir
    g = graph_ir.from_resolved_graph(import_scan.build_resolved_graph(REPO, ANCHOR, SYM))
    codebase.decompose(g)
    t = next((n for n in g.nodes.values() if n.file.replace("\\", "/") == "apps/web/widget.test.ts"), None)
    assert t is not None and t.role == "test"    # verification, not an in-footprint link


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
    from src.codebase import codebase
    from src.core import graph_ir
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
    from src.codebase import codebase
    from src.core import graph_ir
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
